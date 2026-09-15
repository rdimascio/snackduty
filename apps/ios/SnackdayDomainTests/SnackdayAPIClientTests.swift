import Foundation
@testable import SnackdayDomain
import Synchronization
import Testing

private struct RecordedRequest: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data?
}

private struct StubState: Sendable {
    var recorded: [RecordedRequest] = []
    var issuedCookie: String?
}

private let productionCookie = "__Host-snackday_session=stub-production-session"
private let developmentCookie = "snackday_session_dev=stub-development-session"
private let challengeResponse = #"{"challengeId":"challenge_fixture","nonce":"fixture-nonce"}"#

private final class MemoryCookieStore: SessionCookieStoring, Sendable {
    private let values = Mutex<[String: String]>([:])

    func sessionCookie(for origin: URL) -> String? { values.withLock { $0[key(origin)] } }
    func saveSessionCookie(_ cookie: String, for origin: URL) {
        values.withLock { $0[key(origin)] = cookie }
    }
    func clearSession(for origin: URL) { values.withLock { _ = $0.removeValue(forKey: key(origin)) } }

    func stored(for origin: URL) -> String? { values.withLock { $0[key(origin)] } }

    private func key(_ origin: URL) -> String {
        "\(origin.scheme ?? "")://\(origin.host ?? ""):\(origin.port ?? -1)"
    }
}

final class BetaServerStubURLProtocol: URLProtocol {
    fileprivate static let state = Mutex(StubState())

    fileprivate static func reset() { state.withLock { $0 = StubState() } }
    fileprivate static func recordedRequests() -> [RecordedRequest] { state.withLock { $0.recorded } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? "GET"
        let headers = request.allHTTPHeaderFields ?? [:]
        Self.state.withLock {
            $0.recorded.append(
                RecordedRequest(method: method, path: url.path, headers: headers, body: request.httpBody)
            )
        }

        let routed = Self.route(method: method, path: url.path, headers: headers, body: request.httpBody)
        var responseHeaders = ["Content-Type": "application/json; charset=utf-8"]
        responseHeaders.merge(routed.headers) { _, new in new }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: routed.status,
            httpVersion: "HTTP/1.1",
            headerFields: responseHeaders
        ) else { return }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(routed.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func route(
        method: String,
        path: String,
        headers: [String: String],
        body: Data?
    ) -> (status: Int, body: String, headers: [String: String]) {
        if method == "POST", path == "/api/auth/apple/challenge" {
            return (200, challengeResponse, [:])
        }
        if method == "POST", path == "/api/auth/apple/sign-in" {
            guard let body,
                  let input = try? JSONDecoder().decode(AppleSignInRequestDTO.self, from: body),
                  input.challengeId == "challenge_fixture", input.adultConsent
            else { return (400, #"{"error":"invalid sign-in"}"#, [:]) }
            state.withLock { $0.issuedCookie = productionCookie }
            return (
                200,
                identityFixture,
                ["Set-Cookie": "\(productionCookie); Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600"]
            )
        }

#if DEBUG
        if method == "POST", path == "/api/dev/sign-in" {
            state.withLock { $0.issuedCookie = developmentCookie }
            return (
                200,
                identityFixture,
                ["Set-Cookie": "\(developmentCookie); Path=/; HttpOnly; SameSite=Lax; Max-Age=3600"]
            )
        }
#endif

        guard isAuthorized(headers) else {
            return (401, #"{"error":"authentication required"}"#, [:])
        }
        if method == "GET", path == "/api/session" { return (200, identityFixture, [:]) }
        if method == "POST", path == "/api/session/logout" {
            state.withLock { $0.issuedCookie = nil }
            return (200, #"{"signedOut":true}"#, [:])
        }
        if method == "GET", path == "/api/teams" { return (200, teamsFixture, [:]) }
        if method == "GET",
           path == "/api/teams/team_11111111-1111-4111-8111-111111111111/seasons/season_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/roster"
        {
            return (200, rosterFixture, [:])
        }
        return (404, #"{"error":"not found"}"#, [:])
    }

    private static func isAuthorized(_ headers: [String: String]) -> Bool {
        guard let issued = state.withLock({ $0.issuedCookie }) else { return false }
        let cookie = headers.first { $0.key.caseInsensitiveCompare("Cookie") == .orderedSame }?.value
        return cookie?.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            .contains(issued) == true
    }
}

private func makeStubClient(
    baseURL: URL = URL(string: "https://api.snackday.test")!,
    cookieStore: any SessionCookieStoring,
    development: Bool = false
) -> SnackdayAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BetaServerStubURLProtocol.self]
#if DEBUG
    if development {
        return SnackdayAPIClient.development(
            baseURL: baseURL,
            configuration: configuration,
            cookieStore: cookieStore
        )
    }
#endif
    return SnackdayAPIClient(baseURL: baseURL, configuration: configuration, cookieStore: cookieStore)
}

@Suite(.serialized) struct SnackdayAPIClientTests {
    @Test func credentialEpochRejectsLateWritesAndClears() async throws {
        let origin = URL(string: "https://api.snackday.test")!
        let store = MemoryCookieStore()
        let coordinator = SessionCookieCoordinator(store: store)
        let oldCredential = try await coordinator.credential(for: origin)
        let oldEpoch = oldCredential.epoch

        await coordinator.invalidatePendingResponses()
        let currentCredential = try await coordinator.credential(for: origin)
        let currentEpoch = currentCredential.epoch
        try await coordinator.persist("new=session", for: origin, requestEpoch: currentEpoch)
        try await coordinator.persist("old=session", for: origin, requestEpoch: oldEpoch)
        try await coordinator.clear(for: origin, requestEpoch: oldEpoch)

        #expect(store.stored(for: origin) == "new=session")
    }

    @Test func ordinaryClientRejectsInsecureOrigins() async {
        BetaServerStubURLProtocol.reset()
        let client = makeStubClient(
            baseURL: URL(string: "http://localhost:3000")!,
            cookieStore: MemoryCookieStore()
        )

        await #expect(throws: SnackdayAPIError.unavailable) {
            _ = try await client.beginAppleSignIn()
        }
        #expect(BetaServerStubURLProtocol.recordedRequests().isEmpty)
    }

    @Test func appleSignInPersistsCookieAndRestoresWithANewClient() async throws {
        BetaServerStubURLProtocol.reset()
        let store = MemoryCookieStore()
        let first = makeStubClient(cookieStore: store)

        let challenge = try await first.beginAppleSignIn()
        #expect(challenge.challengeId == "challenge_fixture")
        let identity = try await first.completeAppleSignIn(
            AppleSignInRequestDTO(
                challengeId: challenge.challengeId,
                identityToken: "opaque-apple-token",
                displayName: "Fixture Adult",
                adultConsent: true
            )
        )
        #expect(identity.person.displayName == "Development Adult")
        #expect(store.stored(for: URL(string: "https://api.snackday.test")!) == productionCookie)

        let restored = try await makeStubClient(cookieStore: store).currentSession()
        #expect(restored == identity)

        let sessionRequest = try #require(
            BetaServerStubURLProtocol.recordedRequests().last(where: { $0.path == "/api/session" })
        )
        #expect(sessionRequest.headers["Cookie"] == productionCookie)
    }

    @Test func appleSignInSendsFrozenBodyAndSameOriginMetadata() async throws {
        BetaServerStubURLProtocol.reset()
        let client = makeStubClient(cookieStore: MemoryCookieStore())
        _ = try await client.completeAppleSignIn(
            AppleSignInRequestDTO(
                challengeId: "challenge_fixture",
                identityToken: "opaque-token",
                displayName: nil,
                adultConsent: true
            )
        )

        let signIn = try #require(BetaServerStubURLProtocol.recordedRequests().last)
        #expect(signIn.path == "/api/auth/apple/sign-in")
        #expect(signIn.method == "POST")
        #expect(signIn.headers["Sec-Fetch-Site"] == "same-origin")
        #expect(signIn.headers["Content-Type"] == "application/json")
        let body = try #require(signIn.body)
        #expect(try JSONDecoder().decode(AppleSignInRequestDTO.self, from: body).adultConsent)
    }

    @Test func unauthorizedResponseClearsPersistedCredential() async throws {
        BetaServerStubURLProtocol.reset()
        let origin = URL(string: "https://api.snackday.test")!
        let store = MemoryCookieStore()
        store.saveSessionCookie("stale=session", for: origin)
        let client = makeStubClient(baseURL: origin, cookieStore: store, development: true)

        await #expect(throws: SnackdayAPIError.unauthorized) { _ = try await client.currentSession() }
        #expect(store.stored(for: origin) == nil)
    }

    @Test func logoutRevokesBeforeClearingLocalCredential() async throws {
        BetaServerStubURLProtocol.reset()
        let origin = URL(string: "https://api.snackday.test")!
        let store = MemoryCookieStore()
        let client = makeStubClient(baseURL: origin, cookieStore: store)
        _ = try await client.completeAppleSignIn(
            AppleSignInRequestDTO(
                challengeId: "challenge_fixture",
                identityToken: "opaque-token",
                displayName: nil,
                adultConsent: true
            )
        )

        try await client.signOut()

        #expect(store.stored(for: origin) == nil)
        let logout = try #require(BetaServerStubURLProtocol.recordedRequests().last)
        #expect(logout.path == "/api/session/logout")
        #expect(logout.headers["Cookie"] == productionCookie)
    }

    @Test func loadHomeSnapshotNeverSignsInAutomatically() async throws {
        BetaServerStubURLProtocol.reset()
        let origin = URL(string: "https://api.snackday.test")!
        let store = MemoryCookieStore()
        store.saveSessionCookie(productionCookie, for: origin)
        BetaServerStubURLProtocol.state.withLock { $0.issuedCookie = productionCookie }
        let snapshot = try await makeStubClient(baseURL: origin, cookieStore: store).loadHomeSnapshot()

        #expect(snapshot.team.name == "T-Ball Tigers")
        #expect(!BetaServerStubURLProtocol.recordedRequests().contains { $0.path == "/api/dev/sign-in" })
    }

#if DEBUG
    @Test func explicitDevelopmentSignInPreservesLocalHarness() async throws {
        BetaServerStubURLProtocol.reset()
        let origin = URL(string: "http://localhost:3000")!
        let store = MemoryCookieStore()
        let client = makeStubClient(baseURL: origin, cookieStore: store)

        _ = try await client.signInDevelopment(persona: "second-adult")
        #expect(store.stored(for: origin) == developmentCookie)

        let request = try #require(BetaServerStubURLProtocol.recordedRequests().first)
        #expect(request.path == "/api/dev/sign-in")
        let body = try #require(request.body)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(object == ["persona": "second-adult"])
    }
#endif

    @Test(
        "LIVE API (SKIPPED unless SNACKDAY_LIVE_API=<base URL> is set)",
        .enabled(if: ProcessInfo.processInfo.environment["SNACKDAY_LIVE_API"] != nil)
    )
    func liveDevServerRoundTrip() async throws {
#if DEBUG
        let raw = try #require(ProcessInfo.processInfo.environment["SNACKDAY_LIVE_API"])
        let baseURL = try #require(URL(string: raw))
        let client = SnackdayAPIClient.development(baseURL: baseURL)

        let identity = try await client.signInDevelopment()
        #expect(identity.person.displayName == "Development Adult")
        _ = try await client.currentSession()
        let teams = try await client.listTeams()
        if let selection = teams.primarySelection {
            let roster = try await client.loadRoster(
                teamId: selection.team.id,
                seasonId: selection.season.id
            )
            #expect(roster.roster.allSatisfy { !$0.displayName.isEmpty })
        }
#else
        Issue.record("The live development round trip requires a Debug build")
#endif
    }
}
