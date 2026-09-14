import { describe, expect, it } from "bun:test";

import { selectScenarioSimulator } from "./dev-scenario-ios";

const simulators = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-25-4": [
      { udid: "older-booted", name: "iPhone 16", state: "Booted", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: "newest-shutdown", name: "iPhone 17", state: "Shutdown", isAvailable: true },
      { udid: "unavailable", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: false },
    ],
  },
} as const;

describe("development scenario simulator selection", () => {
  it("reuses a booted iPhone by default and accepts an explicit name or UDID", () => {
    expect(selectScenarioSimulator(simulators)).toMatchObject({ udid: "older-booted" });
    expect(selectScenarioSimulator(simulators, "iPhone 17")).toMatchObject({
      udid: "newest-shutdown",
    });
    expect(selectScenarioSimulator(simulators, "newest-shutdown")).toMatchObject({
      name: "iPhone 17",
    });
  });

  it("refuses unavailable or unknown devices", () => {
    expect(() => selectScenarioSimulator(simulators, "iPhone 17 Pro")).toThrow(
      'no available iPhone simulator matches "iPhone 17 Pro"',
    );
    expect(() => selectScenarioSimulator({ devices: {} })).toThrow(
      "no available iPhone simulator is installed",
    );
  });
});
