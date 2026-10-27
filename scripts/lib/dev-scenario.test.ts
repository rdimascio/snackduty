import { describe, expect, it, spyOn } from "bun:test";

import { DevScenarioApi } from "./dev-scenario-api";
import { checkDevScenario, formatDevScenarioInstructions } from "./dev-scenario";
import { verifyPlayerCard } from "./dev-scenario-seed";
import {
  SCENARIO_DRILL_DAYS,
  scenarioPlayerId,
  scenarioSkillEvents,
} from "./dev-scenario-skill-events";
import { parseSkillEvents, rate, rulesV0, taxonomyV0 } from "../../packages/skill-engine/src/index";

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

describe("player card verification", () => {
  const areas = [{ area: "mental", rating: 4 }];
  const seeded = { overall: 2, areas, streakDays: 3, scoredSkills: 1 };

  it("accepts a card with a positive overall and a streak of at least three days", () => {
    expect(() => verifyPlayerCard(seeded)).not.toThrow();
  });

  it("rejects a card that no seeded event reached", () => {
    expect(() => verifyPlayerCard({ ...seeded, scoredSkills: 0 })).toThrow(
      "verify-player-card: the seeded events did not score any skill on the player card",
    );
  });

  it("rejects a card without areas", () => {
    expect(() => verifyPlayerCard({ ...seeded, areas: [] })).toThrow(
      "verify-player-card: the player card carries no areas",
    );
  });

  it("rejects a card with a zero overall", () => {
    expect(() => verifyPlayerCard({ ...seeded, overall: 0 })).toThrow(
      "verify-player-card: the player card overall rating is 0",
    );
  });

  it("rejects a card with a streak shorter than three days", () => {
    expect(() => verifyPlayerCard({ ...seeded, streakDays: 2 })).toThrow(
      "verify-player-card: the player card streak is 2 days; expected at least 3",
    );
  });
});

describe("scenario training week", () => {
  const timeZone = "America/Los_Angeles";

  it.each([
    ["an ordinary day", Date.UTC(2026, 9, 26, 19)],
    ["the day after spring forward, just after local midnight", Date.UTC(2026, 2, 9, 7, 30)],
    ["fall-back day, just before local midnight", Date.UTC(2026, 10, 2, 7, 59)],
  ])("rates overall above zero with a current streak on %s", (_label, nowMs) => {
    const events = parseSkillEvents(scenarioSkillEvents("participant_scenario-1", nowMs, timeZone));
    const card = rate(events, taxonomyV0, rulesV0, { ruleset: "little-league" });

    expect(card.overall).toBeGreaterThan(0);
    expect(Math.max(...card.skills.map((skill) => skill.streakAtLast))).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => Date.parse(event.occurredAt) <= nowMs)).toBe(true);
    expect(
      events
        .map((event) => event.localDate)
        .toSorted()
        .at(-1),
    ).toBe(new Intl.DateTimeFormat("en-CA", { timeZone }).format(nowMs));
    expect(new Set(events.map((event) => event.localDate)).size).toBe(SCENARIO_DRILL_DAYS);
  });

  it("carries one module_completed, one high_five and drills across several areas", () => {
    const events = scenarioSkillEvents("participant_scenario-1", Date.now(), timeZone);
    const types = events.map((event) => event.type);

    expect(types.filter((type) => type === "module_completed")).toHaveLength(1);
    expect(types.filter((type) => type === "high_five")).toHaveLength(1);
    const drillAreas = new Set(
      events
        .filter((event) => event.type === "drill_completed")
        .map((event) => event.skill.split(".")[0]),
    );
    expect(drillAreas.size).toBeGreaterThanOrEqual(4);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.playerId))).toEqual(
      new Set([scenarioPlayerId("participant_scenario-1")]),
    );
  });
});

describe("local development scenario", () => {
  it("boots, seeds two isolated team roles and a lesson through HTTP, verifies them, and tears down", async () => {
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
    expect(manifest.lesson.title.length).toBeGreaterThan(0);
    expect(manifest.lesson.answeredItems).toBeGreaterThan(0);
    expect(instructions).toContain(`Lesson of the week on /app: "${manifest.lesson.title}"`);
    expect(instructions).toContain('"Player card" section above the roster shows Avery Scenario');
    expect(manifest.skillEvents.drillDays).toBe(7);
    expect(manifest.skillEvents.posted).toBeGreaterThan(manifest.skillEvents.drillDays);
    expect(instructions).toContain("The owner sees the same player cards read-only");
    expect(instructions).toContain("never in production");
    expect(instructions).not.toContain("snackday_session_dev=");
    expect(instructions).not.toMatch(/\/invite#[0-9a-f]+/u);
  }, 45_000);
});
