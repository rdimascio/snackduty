import Foundation
import XCTest

/// Real HTTP + real native views, using explicit synthetic development adults.
/// The acceptance runner creates the two-team scenario before invoking this test.
final class LiveCoordinationUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testRealCoachParentCoordination() async throws {
        guard let base = ProcessInfo.processInfo.environment["SNACKDAY_LIVE_API"],
              let teamID = ProcessInfo.processInfo.environment["SNACKDAY_LIVE_UI_TEAM_ID"] else {
            throw XCTSkip("The real coordination UI journey requires the acceptance server and scenario")
        }
        let title = "UI practice \(UUID().uuidString.prefix(8))"
        var app = launch(base: base, persona: "default")
        chooseTeam("Scenario Comets", in: app)
        app.tabBars.buttons["Schedule"].tap()
        let create = app.buttons["schedule-create-event"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.tap()
        let titleField = app.textFields["create-event-title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText(title)
        app.buttons["create-event-save"].tap()
        let event = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "schedule-event-"))
            .matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 10))
        let occurrenceID = String(event.identifier.dropFirst("schedule-event-".count))
        keepScreenshot(app, name: "Real API coach created an event")
        app.terminate()

        app = launch(base: base, persona: "second-adult")
        chooseTeam("Scenario Comets", in: app)
        app.tabBars.buttons["Schedule"].tap()
        let parentEvent = app.buttons["schedule-event-\(occurrenceID)"]
        XCTAssertTrue(parentEvent.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["schedule-create-event"].exists)
        parentEvent.tap()
        let option = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "rsvp-option-")).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 10))
        let participantID = String(option.identifier.dropFirst("rsvp-option-".count))
        option.tap()
        let going = app.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label == %@", "rsvp-yes-\(participantID)", "Going"
        )).firstMatch
        XCTAssertTrue(going.waitForExistence(timeout: 5))
        going.tap()
        let claim = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "duty-claim-")).firstMatch
        XCTAssertTrue(claim.waitForExistence(timeout: 10))
        let slotID = String(claim.identifier.dropFirst("duty-claim-".count))
        XCTAssertTrue(claim.waitForEnabled(timeout: 10))
        claim.tap()
        XCTAssertTrue(claim.waitForDisappearance(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["duty-claimed-self"].waitForExistence(timeout: 10))
        keepScreenshot(app, name: "Real API parent RSVP and snack claim")

        let server = try LiveUIAPI(base: base)
        let session = try await server.signInParent()
        let attendance: LiveAttendance = try await server.get(
            "api/teams/\(teamID)/occurrences/\(occurrenceID)/attendance", cookie: session.cookie
        )
        XCTAssertEqual(attendance.attendance.counts.yes, 1)
        XCTAssertEqual(attendance.attendance.entries.map(\.displayName), ["Jordan Scenario"])
        let duties: LiveDuties = try await server.get(
            "api/teams/\(teamID)/occurrences/\(occurrenceID)/duty-slots", cookie: session.cookie
        )
        XCTAssertEqual(duties.dutySlots.first(where: { $0.id == slotID })?.assignee?.personId, session.personID)

        app.tabBars.buttons["Home"].tap()
        chooseTeam("Scenario Falcons", in: app)
        app.tabBars.buttons["Schedule"].tap()
        XCTAssertTrue(app.buttons["schedule-create-event"].waitForExistence(timeout: 10))
        keepScreenshot(app, name: "Same adult coaches an independent second team")
        app.terminate()
    }

    @MainActor private func launch(base: String, persona: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SNACKDAY_API_BASE_URL"] = base
        app.launchEnvironment["SNACKDAY_DEV_SIGN_IN"] = "true"
        app.launchEnvironment["SNACKDAY_DEV_PERSONA"] = persona
        app.launch()
        return app
    }

    @MainActor private func chooseTeam(_ name: String, in app: XCUIApplication) {
        let picker = app.buttons["team-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        if !picker.label.contains(name) {
            picker.tap()
            let choice = app.buttons[name]
            XCTAssertTrue(choice.waitForExistence(timeout: 5))
            choice.tap()
        }
        let selected = NSPredicate(format: "label CONTAINS %@", name)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: selected, object: picker)], timeout: 10), .completed)
    }

    @MainActor private func keepScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private extension XCUIElement {
    func waitForEnabled(timeout: TimeInterval) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: self)], timeout: timeout) == .completed
    }
    func waitForDisappearance(timeout: TimeInterval) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: self)], timeout: timeout) == .completed
    }
}

private struct LiveAttendance: Decodable {
    struct Attendance: Decodable {
        struct Counts: Decodable { let yes: Int }
        struct Entry: Decodable { let displayName: String }
        let counts: Counts
        let entries: [Entry]
    }
    let attendance: Attendance
}
private struct LiveDuties: Decodable {
    struct Slot: Decodable {
        struct Assignee: Decodable { let personId: String }
        let id: String
        let assignee: Assignee?
    }
    let dutySlots: [Slot]
}
private struct LiveUIAPI {
    let base: URL
    init(base: String) throws {
        self.base = try XCTUnwrap(URL(string: base))
    }
    func signInParent() async throws -> (cookie: String, personID: String) {
        var request = URLRequest(url: base.appending(path: "api/dev/sign-in"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        request.httpBody = Data(#"{"persona":"second-adult"}"#.utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard http.statusCode == 200,
              let header = http.value(forHTTPHeaderField: "Set-Cookie"),
              let cookie = header.split(separator: ";").first else {
            throw NSError(domain: "LiveUI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Synthetic sign-in failed"])
        }
        struct Identity: Decodable { struct Person: Decodable { let id: String }; let person: Person }
        let identity = try JSONDecoder().decode(Identity.self, from: data)
        return (String(cookie), identity.person.id)
    }
    func get<T: Decodable>(_ path: String, cookie: String) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "LiveUI", code: 2, userInfo: [NSLocalizedDescriptionKey: "Authorized coordination read failed"])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
