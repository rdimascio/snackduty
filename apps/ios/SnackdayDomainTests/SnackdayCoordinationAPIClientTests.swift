import Foundation
@testable import SnackdayDomain
import Synchronization
import Testing

private struct CoordinationRecordedRequest: Sendable {
    let method: String
    let percentEncodedPath: String
    let headers: [String: String]
    let body: Data?
}

private struct CoordinationStubResponse: Sendable {
    let status: Int
    let body: Data
}

private struct CoordinationStubState: Sendable {
    var responses: [CoordinationStubResponse] = []
    var requests: [CoordinationRecordedRequest] = []
}

private final class CoordinationURLProtocol: URLProtocol {
    private static let state = Mutex(CoordinationStubState())

    static func reset(responses: [CoordinationStubResponse]) {
        state.withLock {
            $0 = CoordinationStubState(responses: responses)
        }
    }

    static func recordedRequests() -> [CoordinationRecordedRequest] {
        state.withLock { $0.requests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let body = Self.readBody(request)
        let response = Self.state.withLock { state in
            state.requests.append(
                CoordinationRecordedRequest(
                    method: request.httpMethod ?? "GET",
                    percentEncodedPath: URLComponents(
                        url: url,
                        resolvingAgainstBaseURL: false
                    )?.percentEncodedPath ?? "",
                    headers: request.allHTTPHeaderFields ?? [:],
                    body: body
                )
            )
            if state.responses.isEmpty {
                return CoordinationStubResponse(
                    status: 500,
                    body: Data(#"{"error":"missing stub response"}"#.utf8)
                )
            }
            return state.responses.removeFirst()
        }
        guard let http = HTTPURLResponse(
            url: url,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        ) else { return }
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0, result.count + count <= 32_768 else { return nil }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}

private struct CoordinationCookieStore: SessionCookieStoring, Sendable {
    func sessionCookie(for _: URL) -> String? { "snackday_session=test-session" }
    func saveSessionCookie(_: String, for _: URL) {}
    func clearSession(for _: URL) {}
}

private final class CoordinationFixtureBundleToken {}

private func coordinationFixture(named name: String) throws -> Data {
    let bundle = Bundle(for: CoordinationFixtureBundleToken.self)
    let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "fixtures")
        ?? bundle.url(forResource: name, withExtension: "json")
    return try Data(contentsOf: #require(url))
}

private func coordinationResponse(_ fixture: String, status: Int = 200) throws -> CoordinationStubResponse {
    CoordinationStubResponse(status: status, body: try coordinationFixture(named: fixture))
}

private func coordinationClient() -> SnackdayAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CoordinationURLProtocol.self]
    return SnackdayAPIClient(
        baseURL: URL(string: "https://api.snackday.test")!,
        configuration: configuration,
        cookieStore: CoordinationCookieStore()
    )
}

@Suite(.serialized) struct SnackdayCoordinationAPIClientTests {
    @Test func sixOperationsUseAuthorizedPathsBodiesAndCanonicalResponses() async throws {
        let decoder = JSONDecoder()
        let input = try decoder.decode(
            CreateEventRequestDTO.self,
            from: coordinationFixture(named: "event-create-input")
        )
        CoordinationURLProtocol.reset(responses: try [
            coordinationResponse("season-events"),
            coordinationResponse("event-created", status: 201),
            coordinationResponse("attendance-own-child"),
            coordinationResponse("attendance-recorded"),
            coordinationResponse("duty-slots"),
            coordinationResponse("duty-claimed"),
        ])
        let client = coordinationClient()
        let teamID = "team_fixture_coached"
        let seasonID = "season_fixture_coached"
        let occurrenceID = "event_occurrence_fixture"
        let slotID = "duty_slot_fixture"

        let schedule = try await client.listEvents(teamID: teamID, seasonID: seasonID)
        let created = try await client.createEvent(teamID: teamID, seasonID: seasonID, input: input)
        let attendance = try await client.readAttendance(
            teamID: teamID,
            occurrenceID: occurrenceID
        )
        let attendanceInput = AttendanceRequestDTO(
            participantId: "participant_fixture_child",
            status: .yes
        )
        let recorded = try await client.recordAttendance(
            teamID: teamID,
            occurrenceID: occurrenceID,
            input: attendanceInput
        )
        let slots = try await client.listDutySlots(teamID: teamID, occurrenceID: occurrenceID)
        let claimed = try await client.claimDutySlot(
            teamID: teamID,
            occurrenceID: occurrenceID,
            slotID: slotID
        )

        #expect(schedule.events.first?.occurrences.first?.attendance?.yes == 1)
        #expect(created.series.title == input.title)
        #expect(attendance.attendance.responseOptions.map(\.participantId) == [
            "participant_fixture_child", "participant_fixture_sibling",
        ])
        #expect(recorded.attendance == attendanceInput)
        #expect(slots.dutySlots.first?.id == slotID)
        #expect(claimed.dutySlot.assignee?.personId == "person_fixture_adult")

        let requests = CoordinationURLProtocol.recordedRequests()
        #expect(requests.map(\.method) == ["GET", "POST", "GET", "POST", "GET", "POST"])
        #expect(requests.map(\.percentEncodedPath) == [
            "/api/teams/\(teamID)/seasons/\(seasonID)/events",
            "/api/teams/\(teamID)/seasons/\(seasonID)/events",
            "/api/teams/\(teamID)/occurrences/\(occurrenceID)/attendance",
            "/api/teams/\(teamID)/occurrences/\(occurrenceID)/attendance",
            "/api/teams/\(teamID)/occurrences/\(occurrenceID)/duty-slots",
            "/api/teams/\(teamID)/occurrences/\(occurrenceID)/duty-slots/\(slotID)/claim",
        ])
        #expect(requests.allSatisfy { $0.headers["Cookie"] == "snackday_session=test-session" })
        #expect(try decoder.decode(CreateEventRequestDTO.self, from: #require(requests[1].body)) == input)
        #expect(
            try decoder.decode(AttendanceRequestDTO.self, from: #require(requests[3].body))
                == attendanceInput
        )
    }

    @Test func identifiersRemainSinglePercentEncodedPathSegments() async throws {
        CoordinationURLProtocol.reset(responses: [
            CoordinationStubResponse(status: 200, body: Data(#"{"dutySlots":[]}"#.utf8))
        ])

        _ = try await coordinationClient().listDutySlots(
            teamID: "team/../other",
            occurrenceID: "occurrence?redirect=#fragment"
        )

        let request = try #require(CoordinationURLProtocol.recordedRequests().first)
        #expect(
            request.percentEncodedPath
                == "/api/teams/team%2F..%2Fother/occurrences/occurrence%3Fredirect%3D%23fragment/duty-slots"
        )
    }

    @Test func listEventsRejectsMissingAttendanceAndForeignAssociations() async throws {
        let data = try coordinationFixture(named: "season-events")
        var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var events = try #require(object["events"] as? [[String: Any]])
        var event = try #require(events.first)
        var occurrences = try #require(event["occurrences"] as? [[String: Any]])
        occurrences[0].removeValue(forKey: "attendance")
        event["occurrences"] = occurrences
        events[0] = event
        object["events"] = events
        CoordinationURLProtocol.reset(responses: [
            CoordinationStubResponse(status: 200, body: try JSONSerialization.data(withJSONObject: object)),
            CoordinationStubResponse(
                status: 200,
                body: Data(String(decoding: data, as: UTF8.self).replacingOccurrences(
                    of: "season_fixture_coached",
                    with: "season_foreign"
                ).utf8)
            ),
        ])
        let client = coordinationClient()

        await #expect(throws: CoordinationFailure.invalidResponse) {
            _ = try await client.listEvents(
                teamID: "team_fixture_coached",
                seasonID: "season_fixture_coached"
            )
        }
        await #expect(throws: CoordinationFailure.invalidResponse) {
            _ = try await client.listEvents(
                teamID: "team_fixture_coached",
                seasonID: "season_fixture_coached"
            )
        }
    }

    @Test func codedFailuresMapWithoutExposingResponseText() async throws {
        let input = try JSONDecoder().decode(
            CreateEventRequestDTO.self,
            from: coordinationFixture(named: "event-create-input")
        )
        CoordinationURLProtocol.reset(responses: [
            CoordinationStubResponse(
                status: 409,
                body: Data(#"{"code":"duty_slot_taken","error":"private adult details"}"#.utf8)
            ),
            CoordinationStubResponse(
                status: 409,
                body: Data(#"{"code":"event_occurrence_unavailable","error":"private event details"}"#.utf8)
            ),
            CoordinationStubResponse(
                status: 409,
                body: Data(#"{"code":"request_id_conflict","error":"private request details"}"#.utf8)
            ),
            CoordinationStubResponse(
                status: 503,
                body: Data(#"{"error":"private storage details"}"#.utf8)
            ),
        ])
        let client = coordinationClient()

        await #expect(throws: CoordinationFailure.dutyTaken) {
            _ = try await client.claimDutySlot(
                teamID: "team",
                occurrenceID: "occurrence",
                slotID: "slot"
            )
        }
        await #expect(throws: CoordinationFailure.occurrenceUnavailable) {
            _ = try await client.claimDutySlot(
                teamID: "team",
                occurrenceID: "occurrence",
                slotID: "slot"
            )
        }
        await #expect(throws: CoordinationFailure.requestConflict) {
            _ = try await client.createEvent(teamID: "team", seasonID: "season", input: input)
        }
        await #expect(throws: SnackdayAPIError.requestFailed(statusCode: 503)) {
            _ = try await client.listEvents(teamID: "team", seasonID: "season")
        }
    }
}
