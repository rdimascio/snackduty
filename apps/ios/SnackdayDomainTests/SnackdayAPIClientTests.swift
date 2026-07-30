import Foundation
import SnackdayDomain
import Synchronization
import Testing

// A tiny in-memory dev server behind URLProtocol: sign-in mints a session
// cookie exactly like the real server (no Secure flag), and the read routes
// require it. This exercises the client's real cookie round trip through the
// URL session's HTTPCookieStorage.

private struct RecordedRequest: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
}

private struct StubState: Sendable {
    var recorded: [RecordedRequest] = []
    var issuedToken: String?
}

private let stubToken = "stub-dev-session-token"

final class DevServerStubURLProtocol: URLProtocol {
    fileprivate static let state = Mutex(StubState())

    fileprivate static func reset() {
        state.withLock { $0 = StubState() }
    }

    fileprivate static func recordedRequests() -> [RecordedRequest] {
        state.withLock { $0.recorded }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let method = request.httpMethod ?? "GET"
        let headers = request.allHTTPHeaderFields ?? [:]
        Self.state.withLock {
            $0.recorded.append(RecordedRequest(method: method, path: url.path, headers: headers))
        }

        let (status, body, extraHeaders) = Self.route(method: method, path: url.path, headers: headers)
        var responseHeaders = ["Content-Type": "application/json; charset=utf-8"]
        responseHeaders.merge(extraHeaders) { _, new in new }
        guard
            let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: responseHeaders
            )
        else { return }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func route(
        method: String,
        path: String,
        headers: [String: String]
    ) -> (status: Int, body: String, headers: [String: String]) {
        if method == "POST", path == "/api/dev/sign-in" {
            state.withLock { $0.issuedToken = stubToken }
            let cookie = "snackday_session_dev=\(stubToken); Path=/; HttpOnly; SameSite=Lax; Max-Age=86400"
            return (200, identityFixture, ["Set-Cookie": cookie])
        }

        guard isAuthorized(headers) else {
            return (401, #"{"error":"authentication required"}"#, [:])
        }

        if method == "GET", path == "/api/teams" {
            return (200, teamsFixture, [:])
        }
        if method == "GET",
            path
                == "/api/teams/team_11111111-1111-4111-8111-111111111111/seasons/season_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/roster"
        {
            return (200, rosterFixture, [:])
        }

        return (404, #"{"error":"not found"}"#, [:])
    }

    private static func isAuthorized(_ headers: [String: String]) -> Bool {
        guard let issued = state.withLock({ $0.issuedToken }) else { return false }
        let cookieHeader = headers.first { $0.key.caseInsensitiveCompare("Cookie") == .orderedSame }?.value
        guard let cookieHeader else { return false }
        return cookieHeader
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .contains("snackday_session_dev=\(issued)")
    }
}

private func makeStubClient() -> SnackdayAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DevServerStubURLProtocol.self]
    return SnackdayAPIClient(baseURL: URL(string: "http://localhost:3000")!, configuration: configuration)
}

@Suite(.serialized) struct SnackdayAPIClientTests {
    @Test func signInStoresCookieAndAuthorizesReads() async throws {
        DevServerStubURLProtocol.reset()
        let client = makeStubClient()

        let identity = try await client.signInDevelopment()
        #expect(identity.person.displayName == "Development Adult")

        let teams = try await client.listTeams()
        let selection = try #require(teams.primarySelection)
        #expect(selection.team.name == "T-Ball Tigers")

        let roster = try await client.loadRoster(
            teamId: selection.team.id,
            seasonId: selection.season.id
        )
        #expect(roster.roster.count == 2)

        let reads = DevServerStubURLProtocol.recordedRequests().dropFirst()
        #expect(reads.count == 2)
        for read in reads {
            let cookie = read.headers.first {
                $0.key.caseInsensitiveCompare("Cookie") == .orderedSame
            }?.value
            #expect(cookie?.contains("snackday_session_dev=\(stubToken)") == true)
        }
    }

    @Test func unauthorizedReadSurfacesTypedError() async {
        DevServerStubURLProtocol.reset()
        let client = makeStubClient()

        await #expect(throws: SnackdayAPIError.unauthorized) {
            _ = try await client.listTeams()
        }
    }

    @Test func signInPostDeclaresSameOriginFetchMetadataAndSendsNoBody() async throws {
        DevServerStubURLProtocol.reset()
        let client = makeStubClient()

        try await client.signInDevelopment()

        let signIn = try #require(DevServerStubURLProtocol.recordedRequests().first)
        #expect(signIn.method == "POST")
        #expect(signIn.path == "/api/dev/sign-in")
        let fetchSite = signIn.headers.first {
            $0.key.caseInsensitiveCompare("Sec-Fetch-Site") == .orderedSame
        }?.value
        #expect(fetchSite == "same-origin")
        let contentLength = signIn.headers.first {
            $0.key.caseInsensitiveCompare("Content-Length") == .orderedSame
        }?.value
        #expect(contentLength == nil || contentLength == "0")
    }

    @Test func loadHomeSnapshotComposesSignInReadsAndMapping() async throws {
        DevServerStubURLProtocol.reset()
        let client = makeStubClient()

        let snapshot = try await client.loadHomeSnapshot(greeting: "Welcome back")

        #expect(snapshot.team == TeamSummary(name: "T-Ball Tigers", season: "Spring 2026"))
        #expect(snapshot.roster.map(\.displayName) == ["Avery Fixture", "Riley Fixture"])
        #expect(snapshot.roster.first?.guardians.count == 2)
    }

    // The end-to-end task drives this against a real server:
    //   SNACKDAY_DEV_SIGN_IN=true bun run --filter web dev
    //   SNACKDAY_LIVE_API=http://localhost:3000 bun run --filter ios test
    // Without SNACKDAY_LIVE_API it is SKIPPED, and the display name says so.
    @Test(
        "LIVE API (SKIPPED unless SNACKDAY_LIVE_API=<base URL> is set)",
        .enabled(if: ProcessInfo.processInfo.environment["SNACKDAY_LIVE_API"] != nil)
    )
    func liveDevServerRoundTrip() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["SNACKDAY_LIVE_API"])
        let baseURL = try #require(URL(string: raw))
        let client = SnackdayAPIClient(baseURL: baseURL)

        let identity = try await client.signInDevelopment()
        #expect(identity.person.displayName == "Development Adult")

        let teams = try await client.listTeams()
        if let selection = teams.primarySelection {
            let roster = try await client.loadRoster(
                teamId: selection.team.id,
                seasonId: selection.season.id
            )
            #expect(roster.roster.allSatisfy { !$0.displayName.isEmpty })
        }
    }
}
