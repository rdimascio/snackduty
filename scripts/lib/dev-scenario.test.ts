import { describe, expect, it, spyOn } from "bun:test";

import { DevScenarioApi } from "./dev-scenario-api";
import { checkDevScenario, formatDevScenarioInstructions } from "./dev-scenario";

describe("scenario HTTP failures", () => {
  it("reports status and operation without exposing a response body", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"token":"invite-secret","cookie":"session-secret"}', { status: 500 }),
    );
    try {
      const request = new DevScenarioApi("http://127.0.0.1:3000").listTeams("private-cookie");
      await expect(request).rejects.toThrow("GET /api/teams answered 500; expected 200");
      await expect(request).rejects.not.toThrow("invite-secret");
      await expect(request).rejects.not.toThrow("session-secret");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("local development scenario", () => {
  it("boots, seeds two isolated team roles through HTTP, verifies them, and tears down", async () => {
    const manifest = await checkDevScenario();

    expect(manifest.webBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(manifest.nativeApiBaseUrl).toBe(manifest.webBaseUrl.replace("127.0.0.1", "localhost"));
    expect(manifest.teams.coached.name).toBe("Scenario Falcons");
    expect(manifest.teams.family.name).toBe("Scenario Comets");
    expect(manifest.teams.coached.teamId).not.toBe(manifest.teams.family.teamId);
    expect(manifest.teams.coached.playerId).not.toBe(manifest.teams.family.playerId);
    expect(manifest.personas).toEqual({
      owner: { key: "default", displayName: "Development Adult" },
      coachParent: { key: "second-adult", displayName: "Second Development Adult" },
    });

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("snackday_session_dev");
    expect(serialized).not.toContain("invite#");
    expect(serialized).not.toContain("token");

    const instructions = formatDevScenarioInstructions(manifest);
    expect(instructions).toContain(`${manifest.webBaseUrl}/app`);
    expect(instructions).toContain(`SNACKDAY_API_BASE_URL=${manifest.nativeApiBaseUrl}`);
    expect(instructions).toContain("second-adult");
    expect(instructions).not.toContain("snackday_session_dev=");
    expect(instructions).not.toMatch(/\/invite#[0-9a-f]+/u);
  }, 45_000);
});
