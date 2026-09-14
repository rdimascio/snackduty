import XCTest

final class SnackdayUISmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testHomeRosterPrivacyAndTabNavigation() throws {
        let app = XCUIApplication()
        app.launchArguments.append("-SNACKDAY_UI_TEST_FIXTURE")
        app.launch()

        let privateGuardians = app.descendants(matching: .any)["roster-guardians-private"]
        reveal(privateGuardians, in: app)
        XCTAssertTrue(privateGuardians.label.contains("Guardian details are private"))
        XCTAssertFalse(privateGuardians.label.contains("No guardians on file"))

        let emptyGuardians = app.descendants(matching: .any)["roster-guardians-empty"]
        reveal(emptyGuardians, in: app)
        XCTAssertTrue(emptyGuardians.label.contains("No guardians on file"))
        XCTAssertFalse(emptyGuardians.label.contains("Guardian details are private"))

        let rosterAttachment = XCTAttachment(screenshot: app.screenshot())
        rosterAttachment.name = "Synthetic roster privacy states"
        rosterAttachment.lifetime = .keepAlways
        add(rosterAttachment)

        let teamTab = app.tabBars.buttons["Team"]
        XCTAssertTrue(teamTab.waitForExistence(timeout: 2))
        teamTab.tap()
        XCTAssertTrue(app.navigationBars["Team"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Coming next."].waitForExistence(timeout: 2))
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            if element.exists, element.isHittable {
                return
            }
            app.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 2))
        XCTAssertTrue(element.isHittable)
    }
}
