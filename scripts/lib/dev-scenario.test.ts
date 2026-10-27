import { describe, expect, it, spyOn } from "bun:test";

import { SEED_PERSONAS, SEED_TEAMS } from "../../apps/web/app/dev/seed-personas";
import { DevScenarioApi } from "./dev-scenario-api";
import { checkDevScenario, formatDevScenarioInstructions } from "./dev-scenario";
import { scenarioManifest, verifyPlayerCard } from "./dev-scenario-roles";

describe("scenario HTTP failures", () => {
  it("reports status and operation without exposing a response body", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"token":"invite-secret","cookie":"session-secret"}', { status: 500 }),
    );
    try {
      const request = new DevScenarioApi("http://127.0.0.1:3000").teamAccess("private-cookie");
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
  const seeded = { overall: 2, streakDays: 3, scoredSkills: 1 };

  it("accepts a card with a positive overall and a streak of at least three days", () => {
    expect(() => verifyPlayerCard(seeded)).not.toThrow();
  });

  it("rejects a card that no seeded event reached", () => {
    expect(() => verifyPlayerCard({ ...seeded, scoredSkills: 0 })).toThrow(
      "verify-player-card: the seed scored no skill on the card",
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

describe("start-up instructions", () => {
  const manifest = scenarioManifest("http://127.0.0.1:4100", ["001_people.sql"]);

  it("links the role sign-in page and lists every seeded role", () => {
    const instructions = formatDevScenarioInstructions(manifest, 2_345);
    expect(instructions).toContain("(2.3s)");
    expect(instructions).toContain("Sign in as any role: http://127.0.0.1:4100/dev/sign-in");
    for (const persona of SEED_PERSONAS) {
      expect(instructions).toContain(persona.key);
      expect(instructions).toContain(persona.email);
    }
    expect(instructions).toContain(`SNACKDAY_LIVE_UI_TEAM_ID=${SEED_TEAMS.second.teamId}`);
    expect(instructions).toContain("never in production");
  });
});

const REFUSED_PROXY = "http://127.0.0.1:9";
const OFFLINE_SERVER_ENV = {
  HTTP_PROXY: REFUSED_PROXY,
  HTTPS_PROXY: REFUSED_PROXY,
  http_proxy: REFUSED_PROXY,
  https_proxy: REFUSED_PROXY,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

describe("local development scenario", () => {
  it("seeds from SQL before boot, verifies every role over HTTP with outbound network blocked, and tears down", async () => {
    const manifest = await checkDevScenario({ serverEnv: OFFLINE_SERVER_ENV });

    expect(manifest.webBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(manifest.nativeApiBaseUrl).toBe(manifest.webBaseUrl.replace("127.0.0.1", "localhost"));
    expect(manifest.signInPageUrl).toBe(`${manifest.webBaseUrl}/dev/sign-in`);
    expect(manifest.seedFiles[0]).toBe("001_people.sql");
    expect(manifest.teams).toEqual(SEED_TEAMS);
    expect(manifest.personas.map((persona) => persona.key)).toEqual(
      SEED_PERSONAS.map((persona) => persona.key),
    );
    expect(JSON.stringify(manifest)).not.toContain("snackday_session_dev");
  }, 45_000);
});
