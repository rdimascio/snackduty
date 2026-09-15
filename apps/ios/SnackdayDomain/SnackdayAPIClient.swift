import Foundation

/// Typed failures carry no response bodies or decoded payload fragments, so they
/// are safe to render and record without exposing participant data or credentials.
public enum SnackdayAPIError: Error, Equatable, Sendable {
    case unauthorized
    case offline
    case unavailable
    case requestFailed(statusCode: Int)
    case invalidResponse
    case noTeamAvailable
}

/// HTTP implementation of the frozen native transport contract. Authentication
/// remains server-owned: the client persists only the opaque session cookie and
/// every operation sends its team and season identifiers back to an authorized
/// server route.
public struct SnackdayAPIClient: SnackdayTransport, Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let cookies: SessionCookieCoordinator
    private let allowsInsecureLoopback: Bool

    public init(
        baseURL: URL,
        configuration: URLSessionConfiguration = .ephemeral,
        cookieStore: any SessionCookieStoring = KeychainSessionCookieStore()
    ) {
        self.init(
            baseURL: baseURL,
            configuration: configuration,
            cookieStore: cookieStore,
            allowsInsecureLoopback: false
        )
    }

    private init(
        baseURL: URL,
        configuration: URLSessionConfiguration,
        cookieStore: any SessionCookieStoring,
        allowsInsecureLoopback: Bool
    ) {
        self.baseURL = baseURL
        let sessionConfiguration = (configuration.copy() as? URLSessionConfiguration) ?? configuration
        sessionConfiguration.httpShouldSetCookies = false
        sessionConfiguration.httpCookieAcceptPolicy = .never
        sessionConfiguration.httpCookieStorage = nil
        self.session = URLSession(configuration: sessionConfiguration)
        self.cookies = SessionCookieCoordinator(store: cookieStore)
        self.allowsInsecureLoopback = allowsInsecureLoopback
    }

#if DEBUG
    /// The sole insecure transport composition. It still accepts only loopback
    /// hosts, and the entire factory is absent from Release builds.
    public static func development(
        baseURL: URL,
        configuration: URLSessionConfiguration = .ephemeral,
        cookieStore: any SessionCookieStoring = KeychainSessionCookieStore()
    ) -> SnackdayAPIClient {
        SnackdayAPIClient(
            baseURL: baseURL,
            configuration: configuration,
            cookieStore: cookieStore,
            allowsInsecureLoopback: true
        )
    }
#endif

    public func currentSession() async throws -> AdultIdentityDTO {
        try await perform(
            AdultIdentityDTO.self,
            request: request(path: "api/session", method: "GET")
        )
    }

    public func beginAppleSignIn() async throws -> AppleChallengeDTO {
        try await perform(
            AppleChallengeDTO.self,
            request: request(path: "api/auth/apple/challenge", method: "POST")
        )
    }

    /// The server verifies the token, challenge, nonce, audience, expiry, replay
    /// state, and adult consent before minting a session. The identity token is
    /// never retained by this client.
    public func completeAppleSignIn(_ input: AppleSignInRequestDTO) async throws -> AdultIdentityDTO {
        let credential = try await authenticationCredential()
        return try await perform(
            AdultIdentityDTO.self,
            request: try request(path: "api/auth/apple/sign-in", method: "POST", body: input),
            credential: credential
        )
    }

    /// The local credential is removed after confirmed revocation. A 401 is also
    /// a successful local outcome because no active server session remains.
    public func signOut() async throws {
        let credential = try await authenticationCredential()
        do {
            let response = try await perform(
                SignOutResponseDTO.self,
                request: request(path: "api/session/logout", method: "POST"),
                credential: credential
            )
            guard response.signedOut else { throw SnackdayAPIError.invalidResponse }
            try await cookies.clear(for: baseURL, requestEpoch: credential.epoch)
        } catch SnackdayAPIError.unauthorized {
            try await cookies.clear(for: baseURL, requestEpoch: credential.epoch)
        }
    }

    public func listTeams() async throws -> TeamsResponse {
        try await perform(TeamsResponse.self, request: request(path: "api/teams", method: "GET"))
    }

    public func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse {
        try await perform(
            RosterResponse.self,
            request: request(
                path: "api/teams/\(teamId)/seasons/\(seasonId)/roster",
                method: "GET"
            )
        )
    }

    /// Compatibility convenience for existing callers. It uses the current
    /// authenticated session and never creates a development session implicitly.
    public func loadHomeSnapshot(greeting: String = "Welcome back") async throws -> HomeSnapshot {
        guard let selection = try await listTeams().primarySelection else {
            throw SnackdayAPIError.noTeamAvailable
        }
        let roster = try await loadRoster(teamId: selection.team.id, seasonId: selection.season.id)
        return HomeSnapshot.from(selection: selection, roster: roster.roster, greeting: greeting)
    }

#if DEBUG
    /// Explicit local-harness adapter. Release builds contain no operation that
    /// can mint a fixed development persona.
    @discardableResult
    public func signInDevelopment(persona: String? = nil) async throws -> DevIdentityDTO {
        guard allowsInsecureLoopback else { throw SnackdayAPIError.unavailable }
        struct DevelopmentSignInBody: Encodable {
            let persona: String
        }

        let signInRequest: URLRequest
        if let persona {
            signInRequest = try request(
                path: "api/dev/sign-in",
                method: "POST",
                body: DevelopmentSignInBody(persona: persona)
            )
        } else {
            signInRequest = request(path: "api/dev/sign-in", method: "POST")
        }
        let credential = try await authenticationCredential()
        return try await perform(DevIdentityDTO.self, request: signInRequest, credential: credential)
    }
#endif

    private func request(path: String, method: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method == "POST" {
            request.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        }
        return request
    }

    private func request<Body: Encodable>(path: String, method: String, body: Body) throws -> URLRequest {
        var request = request(path: path, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw SnackdayAPIError.invalidResponse
        }
        return request
    }

    private func authenticationCredential() async throws -> (header: String?, epoch: UInt64) {
        guard validOrigin else { throw SnackdayAPIError.unavailable }
        do { return try await cookies.beginAuthentication(for: baseURL) }
        catch { throw SnackdayAPIError.unavailable }
    }

    private func authenticated(_ request: URLRequest, credential supplied: (header: String?, epoch: UInt64)?) async throws -> (request: URLRequest, epoch: UInt64) {
        guard validOrigin else { throw SnackdayAPIError.unavailable }
        var request = request
        let credential: (header: String?, epoch: UInt64)
        if let supplied { credential = supplied }
        else { credential = try await cookies.credential(for: baseURL) }
        if let cookie = credential.header {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        return (request, credential.epoch)
    }

    private func persistSessionCookie(
        from response: HTTPURLResponse,
        requestURL: URL,
        requestEpoch: UInt64
    ) async throws {
        let headerFields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String, let value = entry.value as? String else { return }
            result[key] = value
        }
        guard headerFields.keys.contains(where: { $0.caseInsensitiveCompare("Set-Cookie") == .orderedSame }) else {
            return
        }

        let responseCookies = HTTPCookie.cookies(
            withResponseHeaderFields: headerFields,
            for: response.url ?? requestURL
        )
        let activeCookies = responseCookies.filter { cookie in
            cookie.expiresDate.map { $0 > Date() } ?? true
        }
        guard !activeCookies.isEmpty else {
            try await cookies.clear(for: baseURL, requestEpoch: requestEpoch)
            return
        }
        guard let header = HTTPCookie.requestHeaderFields(with: activeCookies)["Cookie"] else {
            throw SnackdayAPIError.invalidResponse
        }
        try await cookies.persist(header, for: baseURL, requestEpoch: requestEpoch)
    }

    private func perform<Payload: Decodable>(
        _ payload: Payload.Type,
        request: URLRequest,
        credential: (header: String?, epoch: UInt64)? = nil
    ) async throws -> Payload {
        let authenticatedRequest: URLRequest
        let requestEpoch: UInt64
        do {
            let prepared = try await authenticated(request, credential: credential)
            authenticatedRequest = prepared.request
            requestEpoch = prepared.epoch
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SnackdayAPIError.unavailable
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authenticatedRequest)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .networkConnectionLost,
                 .notConnectedToInternet, .timedOut:
                throw SnackdayAPIError.offline
            default:
                throw SnackdayAPIError.unavailable
            }
        } catch {
            throw SnackdayAPIError.unavailable
        }

        guard let http = response as? HTTPURLResponse, let requestURL = authenticatedRequest.url else {
            throw SnackdayAPIError.invalidResponse
        }
        do {
            try await persistSessionCookie(
                from: http,
                requestURL: requestURL,
                requestEpoch: requestEpoch
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as SnackdayAPIError {
            throw error
        } catch {
            throw SnackdayAPIError.unavailable
        }

        switch http.statusCode {
        case 200...299:
            break
        case 401:
            try? await cookies.clear(for: baseURL, requestEpoch: requestEpoch)
            throw SnackdayAPIError.unauthorized
        default:
            throw SnackdayAPIError.requestFailed(statusCode: http.statusCode)
        }

        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            // DecodingError context can quote payload fragments, so it never
            // escapes this boundary.
            throw SnackdayAPIError.invalidResponse
        }
    }

    private var validOrigin: Bool {
        guard let scheme = baseURL.scheme?.lowercased(), let host = baseURL.host?.lowercased() else {
            return false
        }
        if scheme == "https" { return true }
        return allowsInsecureLoopback && scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
    }
}
