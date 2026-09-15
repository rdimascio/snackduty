import Foundation
import XCTest

final class CoordinationUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testCoachCreatesEventThenParentRSVPsAndClaimsSnackDuty() throws {
        let app = launchFixture(state: "coordination-ready")
        openSchedule(in: app)

        let create = app.buttons["schedule-create-event"]
        XCTAssertTrue(create.waitForExistence(timeout: 2))
        create.tap()
        XCTAssertTrue(app.navigationBars["Create Event"].waitForExistence(timeout: 2))

        let title = app.textFields["create-event-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 2))
        title.tap()
        title.typeText("UI Test Game")
        let save = app.buttons["create-event-save"]
        XCTAssertTrue(save.isEnabled)
        save.tap()

        XCTAssertTrue(app.staticTexts["UI Test Game"].waitForExistence(timeout: 2))
        attachScreenshot(app, name: "Synthetic created event")

        let fixtureOccurrence = app.descendants(matching: .any)["schedule-event-occurrence-fixture"]
        XCTAssertTrue(fixtureOccurrence.waitForExistence(timeout: 2))
        fixtureOccurrence.tap()
        XCTAssertTrue(app.navigationBars["Fixture Practice"].waitForExistence(timeout: 2))

        let rsvp = app.buttons["rsvp-option-participant-fixture-child"]
        XCTAssertTrue(rsvp.waitForExistence(timeout: 2))
        rsvp.tap()
        let going = app.buttons["rsvp-yes-participant-fixture-child"]
        if going.waitForExistence(timeout: 1) {
            going.tap()
        } else {
            app.buttons["Going"].tap()
        }
        XCTAssertTrue(
            rsvp.waitForLabelContaining("Going", timeout: 2),
            "The server-projected RSVP choice should display its committed status"
        )

        let claim = app.buttons["duty-claim-slot-fixture"]
        XCTAssertTrue(claim.waitForExistence(timeout: 2))
        claim.tap()
        XCTAssertTrue(app.descendants(matching: .any)["duty-claimed-self"].waitForExistence(timeout: 2))
        attachScreenshot(app, name: "Synthetic RSVP and snack claim")
    }

    @MainActor
    func testScheduleFailureRetriesToAnHonestEmptyState() throws {
        let app = launchFixture(state: "coordination-error")
        openSchedule(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["schedule-error"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["You’re offline"].exists)
        // ContentUnavailableView propagates its container identifier to actions.
        app.buttons["Try Again"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["schedule-empty"].waitForExistence(timeout: 2))
        let refresh = app.buttons["Refresh Schedule"]
        XCTAssertTrue(refresh.exists)
        refresh.tap()
        XCTAssertTrue(app.descendants(matching: .any)["schedule-empty"].waitForExistence(timeout: 2))
        attachScreenshot(app, name: "Synthetic schedule recovery")
    }

    @MainActor
    func testCancelledEventRemainsVisibleAndCannotBeChanged() throws {
        let app = launchFixture(state: "coordination-cancelled")
        openSchedule(in: app)
        app.descendants(matching: .any)["schedule-event-occurrence-fixture"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["event-cancelled"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["rsvp-option-participant-fixture-child"].isEnabled)
        XCTAssertFalse(app.buttons["duty-claim-slot-fixture"].isEnabled)
        attachScreenshot(app, name: "Synthetic cancelled event")
    }

    @MainActor
    private func launchFixture(state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments.append(contentsOf: [
            "-SNACKDAY_UI_TEST_FIXTURE",
            "-SNACKDAY_UI_TEST_STATE", state,
        ])
        app.launch()
        return app
    }

    @MainActor
    private func openSchedule(in app: XCUIApplication) {
        XCTAssertTrue(app.tabBars.buttons["Schedule"].waitForExistence(timeout: 2))
        app.tabBars.buttons["Schedule"].tap()
        XCTAssertTrue(app.navigationBars["Schedule"].waitForExistence(timeout: 2))
    }

    @MainActor private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private extension XCUIElement {
    func waitForLabelContaining(_ value: String, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", value)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: self)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }
}
