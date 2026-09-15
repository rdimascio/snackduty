import { describe, expect, it } from "bun:test";

import { TEST_SUCCEEDED, xcodebuildProblems } from "./xcodebuild-verdict";

const UI_TEST = {
  label: "the native UI smoke test",
  namePattern: "SnackdayUISmokeTests[./ ]testHomeRosterPrivacyAndTabNavigation",
} as const;

const LIVE_TEST = {
  label: "the live round-trip test",
  namePattern: "LIVE API|liveDevServerRoundTrip",
} as const;

const swiftPass = [
  TEST_SUCCEEDED,
  "✔ Test mappingPreservesPrivacy() passed after 0.001 seconds.",
  "✔ Test run with 12 tests passed after 0.120 seconds.",
].join("\n");

const uiPass =
  "Test Case '-[SnackdayUITests.SnackdayUISmokeTests " +
  "testHomeRosterPrivacyAndTabNavigation]' passed (8.203 seconds).";

describe("xcodebuild verdict", () => {
  it("requires the named UI smoke in addition to healthy Swift suites", () => {
    expect(xcodebuildProblems(0, `${swiftPass}\n${uiPass}`, { namedTest: UI_TEST })).toEqual([]);

    expect(xcodebuildProblems(0, swiftPass, { namedTest: UI_TEST })).toContain(
      "xcodebuild output never mentions the native UI smoke test",
    );
  });

  it("accepts a focused XCTest UI pass without requiring Swift Testing summaries", () => {
    expect(
      xcodebuildProblems(0, `${TEST_SUCCEEDED}\n${uiPass}`, {
        requireSwiftTests: false,
        namedTest: UI_TEST,
      }),
    ).toEqual([]);
  });

  it("rejects named-only runs that selected zero tests", () => {
    expect(
      xcodebuildProblems(0, TEST_SUCCEEDED, {
        requireSwiftTests: false,
        namedTest: UI_TEST,
      }),
    ).toEqual(["xcodebuild output never mentions the native UI smoke test"]);
  });

  it("rejects a skipped or failed named test even if xcodebuild prints success", () => {
    const skipped =
      "Test Case '-[SnackdayUITests.SnackdayUISmokeTests " +
      "testHomeRosterPrivacyAndTabNavigation]' skipped (0.001 seconds).";

    expect(
      xcodebuildProblems(0, `${TEST_SUCCEEDED}\n${skipped}`, {
        requireSwiftTests: false,
        namedTest: UI_TEST,
      }),
    ).toEqual([
      "the native UI smoke test was SKIPPED — it never reached the test runner",
      "no pass verdict for the native UI smoke test in the xcodebuild output",
    ]);

    expect(
      xcodebuildProblems(65, `${uiPass}\n** TEST FAILED **`, {
        requireSwiftTests: false,
        namedTest: UI_TEST,
      }),
    ).toEqual(["xcodebuild exited 65", `xcodebuild never printed "${TEST_SUCCEEDED}"`]);
  });

  it("distinguishes SKIPPED in the live test name from a lowercase skipped verdict", () => {
    const displayName = "LIVE API (SKIPPED unless SNACKDAY_LIVE_API=<base URL> is set)";
    const passed = `✔ Test ${displayName} passed after 0.100 seconds.`;
    const skipped = `↷ Test ${displayName} skipped because SNACKDAY_LIVE_API is absent.`;

    expect(xcodebuildProblems(0, `${swiftPass}\n${passed}`, { namedTest: LIVE_TEST })).toEqual([]);
    expect(xcodebuildProblems(0, `${swiftPass}\n${skipped}`, { namedTest: LIVE_TEST })).toEqual([
      "the live round-trip test was SKIPPED — it never reached the test runner",
      "no pass verdict for the live round-trip test in the xcodebuild output",
    ]);
  });
});
