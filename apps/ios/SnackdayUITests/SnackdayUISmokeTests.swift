import XCTest

final class SnackdayUISmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testHomeRosterPrivacyAndTabNavigation() throws {
        let app = launchFixture()

        XCTAssertTrue(app.staticTexts["Fixture Team"].waitForExistence(timeout: 2))
        for misleadingClaim in [
            "Assignments", "2 open", "Snack duty", "You’re up May 9", "Photos", "18 new",
            "Forms", "All signed", "Coach Mia",
        ] {
            XCTAssertFalse(app.staticTexts[misleadingClaim].exists)
        }

        let teamTab = app.tabBars.buttons["Team"]
        XCTAssertTrue(teamTab.waitForExistence(timeout: 2))
        teamTab.tap()
        XCTAssertTrue(app.navigationBars["Team"].waitForExistence(timeout: 2))

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

        app.tabBars.buttons["Schedule"].tap()
        XCTAssertTrue(app.navigationBars["Schedule"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Schedule details are not available in this beta yet."].exists)
    }

    @MainActor
    func testSignedOutRequiresAdultConsent() throws {
        let app = launchFixture(state: "signed-out")
        XCTAssertTrue(app.navigationBars["Sign In"].waitForExistence(timeout: 2))
        let signIn = app.buttons["apple-sign-in-button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 2))
        XCTAssertFalse(signIn.isEnabled)
        let consent = app.switches["adult-consent-toggle"]
        XCTAssertTrue(consent.exists)
        consent.tap()
        XCTAssertTrue(signIn.isEnabled)
    }

    @MainActor
    func testLoadingEmptyAndFailureRecovery() throws {
        var app = launchFixture(state: "loading")
        XCTAssertTrue(app.descendants(matching: .any)["team-loading"].waitForExistence(timeout: 2))
        app.terminate()

        app = launchFixture(state: "empty-teams")
        XCTAssertTrue(app.staticTexts["No teams yet"].waitForExistence(timeout: 2))
        app.terminate()

        app = launchFixture(state: "empty-seasons")
        XCTAssertTrue(app.staticTexts["No seasons yet"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["team-picker"].exists)
        app.terminate()

        app = launchFixture(state: "error")
        XCTAssertTrue(app.staticTexts["You’re offline"].waitForExistence(timeout: 2))
        let retry = app.buttons["state-retry"]
        XCTAssertTrue(retry.exists)
        retry.tap()
        XCTAssertTrue(app.staticTexts["No teams yet"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testTeamSeasonSwitchingAndLogout() throws {
        let app = launchFixture()
        let seasonPicker = app.buttons["season-picker"]
        XCTAssertTrue(seasonPicker.waitForExistence(timeout: 2))
        seasonPicker.tap()
        app.buttons["Fixture Fall"].tap()
        XCTAssertTrue(app.staticTexts["Fixture Fall"].waitForExistence(timeout: 2))

        let teamPicker = app.buttons["team-picker"]
        teamPicker.tap()
        app.buttons["Second Fixture Team"].tap()
        XCTAssertTrue(app.staticTexts["Second Fixture Team"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Second Season"].waitForExistence(timeout: 2))

        app.buttons["account-menu"].tap()
        app.buttons["Sign Out"].tap()
        XCTAssertTrue(app.navigationBars["Sign In"].waitForExistence(timeout: 2))
    }

    @MainActor
    private func launchFixture(state: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments.append("-SNACKDAY_UI_TEST_FIXTURE")
        if let state {
            app.launchArguments.append(contentsOf: ["-SNACKDAY_UI_TEST_STATE", state])
        }
        app.launch()
        return app
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
