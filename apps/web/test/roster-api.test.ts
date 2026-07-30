import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const [{ default: config }, { DEV_ACCOUNT_ID }] = await Promise.all([
  import("../lesto.app"),
  import("../app/lib/server/identity"),
]);

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM accounts; DELETE FROM people;",
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
const childInput = { displayName: " Casey Kid ", birthDate: "2018-04-09" };
const guardianInput = { displayName: "Alex Guardian", relationship: "parent" };

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

function addChild(cookie: string, teamId: string, seasonId: string, body: unknown = childInput) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function attachGuardian(cookie: string, participantId: string, body: unknown = guardianInput) {
  return app.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

async function reassignTeamToForeignAdult(teamId: string) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run(["person_other_adult", "Other Adult", now, now]);
  await config.db
    .prepare("UPDATE teams SET created_by_person_id = ? WHERE id = ?")
    .run(["person_other_adult", teamId]);
}

describe("authorized roster mutations", () => {
  it("adds a child Participant with guardians and no child Account or email", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const addedChild = await addChild(cookie, teamId, seasonId);
    expect(addedChild.status).toBe(201);
    const participant = (json(addedChild) as { participant: Record<string, string> }).participant;
    expect(participant).toEqual({
      participantId: participant.participantId,
      displayName: "Casey Kid",
      birthDate: "2018-04-09",
      status: "active",
    });
    expect(participant.participantId).toStartWith("participant_");

    const firstGuardian = await attachGuardian(cookie, participant.participantId ?? "");
    expect(firstGuardian.status).toBe(201);
    const first = (json(firstGuardian) as { guardian: Record<string, unknown> }).guardian;
    expect(first).toEqual({
      guardianId: first.guardianId,
      displayName: "Alex Guardian",
      relationship: "parent",
      permissions: ["participant.read", "participant.manage"],
      status: "active",
    });

    const secondGuardian = await attachGuardian(cookie, participant.participantId ?? "", {
      displayName: "Bailey Guardian",
      relationship: "caregiver",
      permissions: ["participant.read"],
    });
    expect(secondGuardian.status).toBe(201);
    const second = (json(secondGuardian) as { guardian: Record<string, unknown> }).guardian;
    expect(second).toMatchObject({
      displayName: "Bailey Guardian",
      relationship: "caregiver",
      permissions: ["participant.read"],
      status: "active",
    });

    const participantRow = (await config.db
      .prepare("SELECT id, person_id, birth_date, status FROM participants WHERE id = ?")
      .get([participant.participantId])) as { person_id: string };
    expect(participantRow).toMatchObject({
      id: participant.participantId,
      birth_date: "2018-04-09",
      status: "active",
    });

    const childPerson = await config.db
      .prepare("SELECT id, display_name, status FROM people WHERE id = ?")
      .get([participantRow.person_id]);
    expect(childPerson).toEqual({
      id: participantRow.person_id,
      display_name: "Casey Kid",
      status: "active",
    });

    // Person/Account separation: the only Account row is the development adult's.
    expect(await config.db.prepare("SELECT id FROM accounts").all()).toEqual([
      { id: DEV_ACCOUNT_ID },
    ]);
    expect(
      await config.db
        .prepare("SELECT id FROM accounts WHERE person_id = ?")
        .all([participantRow.person_id]),
    ).toEqual([]);

    expect(
      await config.db
        .prepare(
          "SELECT team_id, season_id, member_kind, member_person_id, status FROM memberships WHERE member_participant_id = ?",
        )
        .all([participant.participantId]),
    ).toEqual([
      {
        team_id: teamId,
        season_id: seasonId,
        member_kind: "participant",
        member_person_id: null,
        status: "active",
      },
    ]);

    const edges = (await config.db
      .prepare(
        "SELECT guardian_person_id, relationship, status, permissions FROM guardian_relationships WHERE participant_id = ? ORDER BY relationship",
      )
      .all([participant.participantId])) as {
      guardian_person_id: string;
      relationship: string;
      status: string;
      permissions: string;
    }[];
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.relationship).toSorted()).toEqual(["caregiver", "parent"]);
    for (const edge of edges) expect(edge.status).toBe("active");
    const guardianAccounts = await Promise.all(
      edges.map((edge) =>
        config.db
          .prepare("SELECT id FROM accounts WHERE person_id = ?")
          .all([edge.guardian_person_id]),
      ),
    );
    expect(guardianAccounts.flat()).toEqual([]);
    expect(edges.map((edge) => JSON.parse(edge.permissions)).toSorted()).toEqual([
      ["participant.read"],
      ["participant.read", "participant.manage"],
    ]);

    const serialized = JSON.stringify([
      json(addedChild),
      json(firstGuardian),
      json(secondGuardian),
    ]).toLowerCase();
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

  it("rejects a duplicate active guardian pair with a conflict", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const added = await addChild(cookie, teamId, seasonId);
    const participantId = (json(added) as { participant: { participantId: string } }).participant
      .participantId;

    expect((await attachGuardian(cookie, participantId)).status).toBe(201);

    const duplicate = await attachGuardian(cookie, participantId);
    expect(duplicate.status).toBe(409);
    expect(json(duplicate)).toEqual({ error: "guardian already attached" });
    expect(
      await config.db
        .prepare("SELECT id FROM guardian_relationships WHERE participant_id = ?")
        .all([participantId]),
    ).toHaveLength(1);

    // The same display name under a DIFFERENT relationship is a distinct pair.
    expect(
      (
        await attachGuardian(cookie, participantId, {
          displayName: "Alex Guardian",
          relationship: "guardian",
        })
      ).status,
    ).toBe(201);
  });
});

describe("roster authorization boundaries", () => {
  it("requires authentication for both mutations and writes nothing", async () => {
    const responses = [
      await app.handle("POST", "/api/teams/missing/seasons/missing/participants", {
        headers: sameOrigin,
        body: childInput,
      }),
      await app.handle("POST", "/api/participants/missing/guardians", {
        headers: sameOrigin,
        body: guardianInput,
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM people").all()).toEqual([]);
  });

  it("hides a team owned by another Person behind 404 and writes nothing", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    await reassignTeamToForeignAdult(teamId);

    const response = await addChild(cookie, teamId, seasonId);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM memberships").all()).toEqual([]);
  });

  it("hides a participant on a team owned by another Person behind 404", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const added = await addChild(cookie, teamId, seasonId);
    const participantId = (json(added) as { participant: { participantId: string } }).participant
      .participantId;
    await reassignTeamToForeignAdult(teamId);

    const foreign = await attachGuardian(cookie, participantId);
    const missing = await attachGuardian(cookie, "participant_missing");

    for (const response of [foreign, missing]) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "participant not found" });
    }
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
  });

  it("returns 404 for a season that does not belong to the team", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const other = await createTeamAndSeason(cookie);

    const mismatched = await addChild(cookie, teamId, other.seasonId);
    const missing = await addChild(cookie, teamId, "season_missing");

    for (const response of [mismatched, missing]) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });

  it("retains same-origin protection for both mutations", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const crossSite = { "sec-fetch-site": "cross-site", cookie };
    const child = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        headers: crossSite,
        body: childInput,
      },
    );
    const guardian = await app.handle("POST", "/api/participants/missing/guardians", {
      headers: crossSite,
      body: guardianInput,
    });

    expect(child.status).toBe(403);
    expect(guardian.status).toBe(403);
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
  });

  it("rejects invalid input without partial writes", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    await expect(addChild(cookie, teamId, seasonId, { displayName: "   " })).rejects.toMatchObject({
      code: "WEB_VALIDATION_FAILED",
    });
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);

    const added = await addChild(cookie, teamId, seasonId);
    const participantId = (json(added) as { participant: { participantId: string } }).participant
      .participantId;
    await expect(
      attachGuardian(cookie, participantId, { displayName: "   ", relationship: "parent" }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
  });
});
