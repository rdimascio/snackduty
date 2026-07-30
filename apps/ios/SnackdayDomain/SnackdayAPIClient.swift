import Foundation

/// Typed failures for the API client. Cases carry no payload fragments, so an
/// error can be rendered or logged without ever exposing roster or child data.
public enum SnackdayAPIError: Error, Equatable, Sendable {
    case unauthorized
    case requestFailed(statusCode: Int)
    case invalidResponse
    case noTeamAvailable
}

/// Async/await client for the development sign-in flow and the authorized read
/// APIs. The session cookie issued by `POST /api/dev/sign-in` is kept in the
/// URL session's `HTTPCookieStorage` (the dev cookie carries no `Secure` flag,
/// so plain `http://localhost` works on the simulator) and is attached to every
/// subsequent request. Storage and attachment are done explicitly by the client
/// rather than left to the built-in HTTP stack, so the behavior is identical
/// under a `URLProtocol` test stub and against the real server.
public struct SnackdayAPIClient: Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let cookieStorage: HTTPCookieStorage?

    /// - Parameters:
    ///   - baseURL: for example `http://localhost:3000`.
    ///   - configuration: defaults to an ephemeral configuration so the dev
    ///     session cookie lives in memory only and never touches disk.
    public init(baseURL: URL, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        let sessionConfiguration = (configuration.copy() as? URLSessionConfiguration) ?? configuration
        // The client owns the Cookie header (see `request(path:method:)`); the
        // built-in stack must not attach a second copy.
        sessionConfiguration.httpShouldSetCookies = false
        sessionConfiguration.httpCookieAcceptPolicy = .always
        self.cookieStorage = sessionConfiguration.httpCookieStorage
        self.session = URLSession(configuration: sessionConfiguration)
    }

    /// `POST /api/dev/sign-in`. The endpoint rejects any request body, so none
    /// is sent. The response's `Set-Cookie` lands in the session's cookie
    /// storage, authorizing subsequent reads.
    @discardableResult
    public func signInDevelopment() async throws -> DevIdentityDTO {
        try await perform(DevIdentityDTO.self, request: request(path: "api/dev/sign-in", method: "POST"))
    }

    /// `GET /api/teams`
    public func listTeams() async throws -> TeamsResponse {
        try await perform(TeamsResponse.self, request: request(path: "api/teams", method: "GET"))
    }

    /// `GET /api/teams/{teamId}/seasons/{seasonId}/roster`
    public func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse {
        try await perform(
            RosterResponse.self,
            request: request(path: "api/teams/\(teamId)/seasons/\(seasonId)/roster", method: "GET")
        )
    }

    /// Signs in, picks the primary team and season, loads its roster, and maps
    /// everything into the UI model. Throws `SnackdayAPIError.noTeamAvailable`
    /// when the dev account owns no team with a season yet.
    public func loadHomeSnapshot(greeting: String = "Welcome back") async throws -> HomeSnapshot {
        try await signInDevelopment()
        guard let selection = try await listTeams().primarySelection else {
            throw SnackdayAPIError.noTeamAvailable
        }
        let roster = try await loadRoster(teamId: selection.team.id, seasonId: selection.season.id)
        return HomeSnapshot.from(selection: selection, roster: roster.roster, greeting: greeting)
    }

    private func request(path: String, method: String) -> URLRequest {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method == "POST" {
            // The server's CSRF origin check refuses state-changing requests
            // unless the browser fetch metadata marks them same-origin;
            // URLSession sets no fetch metadata, so declare it explicitly.
            request.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        }
        if let cookies = cookieStorage?.cookies(for: url), !cookies.isEmpty {
            for (name, value) in HTTPCookie.requestHeaderFields(with: cookies) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        return request
    }

    private func storeCookies(from response: HTTPURLResponse, requestURL: URL) {
        guard let cookieStorage else { return }
        let headerFields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String, let value = entry.value as? String else { return }
            result[key] = value
        }
        let cookies = HTTPCookie.cookies(
            withResponseHeaderFields: headerFields,
            for: response.url ?? requestURL
        )
        guard !cookies.isEmpty else { return }
        cookieStorage.setCookies(cookies, for: response.url ?? requestURL, mainDocumentURL: nil)
    }

    private func perform<Payload: Decodable>(
        _ payload: Payload.Type,
        request: URLRequest
    ) async throws -> Payload {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, let requestURL = request.url else {
            throw SnackdayAPIError.invalidResponse
        }
        storeCookies(from: http, requestURL: requestURL)
        switch http.statusCode {
        case 200...299:
            break
        case 401:
            throw SnackdayAPIError.unauthorized
        default:
            throw SnackdayAPIError.requestFailed(statusCode: http.statusCode)
        }
        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            // Never rethrow DecodingError: its context can quote payload
            // fragments, and roster payloads contain child data.
            throw SnackdayAPIError.invalidResponse
        }
    }
}
