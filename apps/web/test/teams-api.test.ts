import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const [{ default: config }, { DEV_PERSON_ID }] = await Promise.all([
  import("../lesto.app"),
  import("../app/lib/server/identity"),
]);

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function signIn(): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const teamInput = { name: " T-Ball Tigers " };
const seasonInput = {
  label: " Spring 2026 ",
  startDate: "2026-03-01",
  endDate: "2026-06-01",
  timeZone: " America/Los_Angeles ",
};

function createTeam(cookie: string) {
  return app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: teamInput,
  });
}

describe("authorized team and season API", () => {
  it("persists and reads an owner-scoped team aggregate", async () => {
    const cookie = await signIn();
    const createdTeam = await createTeam(cookie);

    expect(createdTeam.status).toBe(201);
    const team = (json(createdTeam) as { team: Record<string, string> }).team;
    expect(team).toMatchObject({ name: "T-Ball Tigers", status: "active" });
    expect(team.id).toStartWith("team_");

    const createdSeason = await app.handle("POST", `/api/teams/${team.id}/seasons`, {
      headers: { ...sameOrigin, cookie },
      body: seasonInput,
    });

    expect(createdSeason.status).toBe(201);
    const season = (json(createdSeason) as { season: Record<string, string> }).season;
    expect(season).toMatchObject({
      teamId: team.id,
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
      status: "active",
    });
    expect(season.id).toStartWith("season_");

    const read = await app.handle("GET", `/api/teams/${team.id}`, {
      headers: { cookie },
    });
    expect(read.status).toBe(200);
    expect(json(read)).toEqual({ team, seasons: [season] });

    expect(
      await config.db
        .prepare("SELECT id, created_by_person_id FROM teams WHERE id = ?")
        .get([team.id]),
    ).toEqual({ id: team.id, created_by_person_id: DEV_PERSON_ID });
    expect(
      await config.db.prepare("SELECT id, team_id FROM seasons WHERE id = ?").get([season.id]),
    ).toEqual({ id: season.id, team_id: team.id });

    const serialized = JSON.stringify({ team, season }).toLowerCase();
    for (const forbidden of [
      "createdbypersonid",
      "account",
      "person",
      "cookie",
      "token",
      "participant",
      "child",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not disclose or mutate a team owned by another Person", async () => {
    const cookie = await signIn();
    const created = await createTeam(cookie);
    const teamId = (json(created) as { team: { id: string } }).team.id;
    const now = new Date().toISOString();

    await config.db
      .prepare(
        "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .run(["person_other_adult", "Other Adult", now, now]);
    await config.db
      .prepare("UPDATE teams SET created_by_person_id = ? WHERE id = ?")
      .run(["person_other_adult", teamId]);

    const read = await app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
    const createSeason = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
      headers: { ...sameOrigin, cookie },
      body: seasonInput,
    });

    for (const response of [read, createSeason]) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }
    expect(await config.db.prepare("SELECT id FROM seasons").all()).toEqual([]);
  });
});

describe("team API boundaries", () => {
  it("requires authentication for every operation and writes nothing", async () => {
    const responses = [
      await app.handle("POST", "/api/teams", { headers: sameOrigin, body: teamInput }),
      await app.handle("POST", "/api/teams/missing/seasons", {
        headers: sameOrigin,
        body: seasonInput,
      }),
      await app.handle("GET", "/api/teams/missing"),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
    expect(await config.db.prepare("SELECT id FROM teams").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM seasons").all()).toEqual([]);
  });

  it("rejects invalid input without partial writes", async () => {
    const cookie = await signIn();
    await expect(
      app.handle("POST", "/api/teams", {
        headers: { ...sameOrigin, cookie },
        body: { name: "   " },
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    expect(await config.db.prepare("SELECT id FROM teams").all()).toEqual([]);

    const created = await createTeam(cookie);
    const teamId = (json(created) as { team: { id: string } }).team.id;
    await expect(
      app.handle("POST", `/api/teams/${teamId}/seasons`, {
        headers: { ...sameOrigin, cookie },
        body: { ...seasonInput, startDate: "2026-06-02", endDate: "2026-06-01" },
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    expect(await config.db.prepare("SELECT id FROM seasons").all()).toEqual([]);
  });

  it("retains same-origin protection for mutations", async () => {
    const cookie = await signIn();
    const response = await app.handle("POST", "/api/teams", {
      headers: { "sec-fetch-site": "cross-site", cookie },
      body: teamInput,
    });

    expect(response.status).toBe(403);
    expect(await config.db.prepare("SELECT id FROM teams").all()).toEqual([]);
  });
});
