import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("../lesto.app");

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
const childInput = { displayName: "Casey Kid", birthDate: "2018-04-09" };

async function createTeamAndSeason(cookie: string): Promise<{ teamId: string; seasonId: string }> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "T-Ball Tigers" },
  });
  expect(createdTeam.status).toBe(201);
  const teamId = (json(createdTeam) as { team: { id: string } }).team.id;

  const createdSeason = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(createdSeason.status).toBe(201);

  return { teamId, seasonId: (json(createdSeason) as { season: { id: string } }).season.id };
}

async function addChild(cookie: string, teamId: string, seasonId: string): Promise<string> {
  const response = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    {
      headers: { ...sameOrigin, cookie },
      body: childInput,
    },
  );
  expect(response.status).toBe(201);
  return (json(response) as { participant: { participantId: string } }).participant.participantId;
}

async function attachGuardian(
  cookie: string,
  participantId: string,
  body: unknown,
): Promise<string> {
  const response = await app.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
  expect(response.status).toBe(201);
  return (json(response) as { guardian: { guardianId: string } }).guardian.guardianId;
}

async function insertForeignTeamAndSeason(): Promise<{ teamId: string; seasonId: string }> {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run(["person_foreign_adult", "Foreign Adult", now, now]);
  await config.db
    .prepare(
      "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
    )
    .run(["team_foreign", "Foreign Falcons", "person_foreign_adult", now, now]);
  await config.db
    .prepare(
      "INSERT INTO seasons (id, team_id, label, start_date, end_date, time_zone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .run([
      "season_foreign",
      "team_foreign",
      "Fall 2026",
      "2026-09-01",
      "2026-11-15",
      "America/Los_Angeles",
      now,
      now,
    ]);
  return { teamId: "team_foreign", seasonId: "season_foreign" };
}

describe("authorized team reads", () => {
  it("loads the real team roster and team list through the full journey", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const firstGuardianId = await attachGuardian(cookie, participantId, {
      displayName: "Alex Guardian",
      relationship: "parent",
    });
    const secondGuardianId = await attachGuardian(cookie, participantId, {
      displayName: "Bailey Guardian",
      relationship: "caregiver",
      permissions: ["participant.read"],
    });

    const rosterRead = await app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
      headers: { cookie },
    });
    expect(rosterRead.status).toBe(200);
    expect(json(rosterRead)).toEqual({
      roster: [
        {
          participantId,
          displayName: "Casey Kid",
          birthDate: "2018-04-09",
          status: "active",
          guardians: [
            {
              guardianId: firstGuardianId,
              displayName: "Alex Guardian",
              relationship: "parent",
              permissions: ["participant.read", "participant.manage"],
              status: "active",
            },
            {
              guardianId: secondGuardianId,
              displayName: "Bailey Guardian",
              relationship: "caregiver",
              permissions: ["participant.read"],
              status: "active",
            },
          ],
        },
      ],
    });

    // The team list mirrors the single-team read exactly, wrapped in `teams`.
    const singleRead = await app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
    expect(singleRead.status).toBe(200);
    const listRead = await app.handle("GET", "/api/teams", { headers: { cookie } });
    expect(listRead.status).toBe(200);
    expect(json(listRead)).toEqual({ teams: [json(singleRead)] });
    const listedTeam = (json(listRead) as { teams: { team: { id: string } }[] }).teams;
    expect(listedTeam).toHaveLength(1);
    expect(listedTeam[0]?.team.id).toBe(teamId);

    const serialized = JSON.stringify([json(rosterRead), json(listRead)]).toLowerCase();
    for (const forbidden of [
      "email",
      "account",
      "cookie",
      "token",
      "createdbypersonid",
      "person_id",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns an empty roster for a season with no participants", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const response = await app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ roster: [] });
  });

  it("returns an empty team list before any team exists", async () => {
    const cookie = await signIn();

    const response = await app.handle("GET", "/api/teams", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ teams: [] });
  });
});

describe("team read authorization boundaries", () => {
  it("hides a foreign team from the roster read and the team list", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const foreign = await insertForeignTeamAndSeason();

    const rosterRead = await app.handle(
      "GET",
      `/api/teams/${foreign.teamId}/seasons/${foreign.seasonId}/roster`,
      { headers: { cookie } },
    );
    expect(rosterRead.status).toBe(404);
    expect(json(rosterRead)).toEqual({ error: "team not found" });

    const listRead = await app.handle("GET", "/api/teams", { headers: { cookie } });
    expect(listRead.status).toBe(200);
    const teamIds = (json(listRead) as { teams: { team: { id: string } }[] }).teams.map(
      (entry) => entry.team.id,
    );
    expect(teamIds).toEqual([teamId]);
  });

  it("returns 404 for a season that does not belong to the team", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const other = await createTeamAndSeason(cookie);

    const mismatched = await app.handle(
      "GET",
      `/api/teams/${teamId}/seasons/${other.seasonId}/roster`,
      { headers: { cookie } },
    );
    const missing = await app.handle("GET", `/api/teams/${teamId}/seasons/season_missing/roster`, {
      headers: { cookie },
    });

    for (const response of [mismatched, missing]) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }
  });

  it("requires authentication for both reads", async () => {
    const responses = [
      await app.handle("GET", "/api/teams"),
      await app.handle("GET", "/api/teams/missing/seasons/missing/roster"),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
  });
});
