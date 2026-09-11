import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const [{ default: config }, { DEV_PERSONAS }] = await Promise.all([
  import("../lesto.app"),
  import("../app/lib/server/identity"),
]);

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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

const sameOrigin = { "sec-fetch-site": "same-origin" };

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

function dateDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

async function createTeamWithOccurrence(cookie: string, name: string) {
  const teamResponse = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name },
  });
  expect(teamResponse.status).toBe(201);
  const teamId = (json(teamResponse) as { team: { id: string } }).team.id;

  const seasonResponse = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Current season",
      startDate: dateDaysFromNow(-30),
      endDate: dateDaysFromNow(60),
      timeZone: "UTC",
    },
  });
  expect(seasonResponse.status).toBe(201);
  const seasonId = (json(seasonResponse) as { season: { id: string } }).season.id;

  const eventResponse = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/events`,
    {
      headers: { ...sameOrigin, cookie },
      body: {
        title: "Saturday game",
        kind: "game",
        schedule: {
          timeZone: "UTC",
          localTime: "12:00",
          durationMinutes: 60,
          frequency: "once",
          startDate: dateDaysFromNow(10),
        },
      },
    },
  );
  expect(eventResponse.status).toBe(201);
  const occurrenceId = (json(eventResponse) as { occurrences: Array<{ id: string }> })
    .occurrences[0]?.id;
  expect(occurrenceId).toStartWith("event_occurrence_");

  return { teamId, seasonId, occurrenceId: occurrenceId ?? "" };
}

async function joinTeam(ownerCookie: string, teamId: string): Promise<string> {
  const invitation = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: { invitedRole: "adult", inviteeLabel: "Second parent" },
  });
  expect(invitation.status).toBe(201);
  const inviteUrl = (json(invitation) as { invitation: { inviteUrl: string } }).invitation
    .inviteUrl;
  const token = inviteUrl.split("#")[1] ?? "";

  const memberCookie = await signIn("second-adult");
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: memberCookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

function slotPath(fixture: { teamId: string; occurrenceId: string }) {
  return `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/duty-slots`;
}

async function createSlot(
  cookie: string,
  fixture: { teamId: string; occurrenceId: string },
  label = "Bring fruit",
) {
  const response = await app.handle("POST", slotPath(fixture), {
    headers: { ...sameOrigin, cookie },
    body: { label, instructions: "Enough for twelve players" },
  });
  expect(response.status).toBe(201);
  return (json(response) as { dutySlot: { id: string } }).dutySlot.id;
}

function claim(cookie: string, fixture: { teamId: string; occurrenceId: string }, slotId: string) {
  return app.handle("POST", `${slotPath(fixture)}/${slotId}/claim`, {
    headers: { ...sameOrigin, cookie },
  });
}

function release(
  cookie: string,
  fixture: { teamId: string; occurrenceId: string },
  slotId: string,
) {
  return app.handle("POST", `${slotPath(fixture)}/${slotId}/release`, {
    headers: { ...sameOrigin, cookie },
  });
}

function assign(
  cookie: string,
  fixture: { teamId: string; occurrenceId: string },
  slotId: string,
  assigneePersonId: string | null,
) {
  return app.handle("POST", `${slotPath(fixture)}/${slotId}/assignment`, {
    headers: { ...sameOrigin, cookie },
    body: { assigneePersonId },
  });
}

describe("duty slot roles and privacy", () => {
  it("lets managers create and assign while a team adult lists, claims, and releases", async () => {
    const ownerCookie = await signIn();
    const fixture = await createTeamWithOccurrence(ownerCookie, "Duty Falcons");
    const parentCookie = await joinTeam(ownerCookie, fixture.teamId);
    const slotId = await createSlot(ownerCookie, fixture);

    const listed = await app.handle("GET", slotPath(fixture), {
      headers: { cookie: parentCookie },
    });
    expect(listed.status).toBe(200);
    expect(json(listed)).toMatchObject({
      dutySlots: [
        {
          id: slotId,
          occurrenceId: fixture.occurrenceId,
          label: "Bring fruit",
          instructions: "Enough for twelve players",
        },
      ],
    });

    // This adult has no guardian relationship and supplies no child identity.
    // Duty authorization comes only from their active adult team membership.
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
    const claimed = await claim(parentCookie, fixture, slotId);
    expect(claimed.status).toBe(200);
    expect(json(claimed)).toMatchObject({
      dutySlot: {
        assignee: {
          personId: DEV_PERSONAS["second-adult"].personId,
          displayName: DEV_PERSONAS["second-adult"].displayName,
        },
      },
    });
    for (const forbidden of ["participant", "child", "guardian", "household"]) {
      expect(claimed.body.toLowerCase()).not.toContain(forbidden);
    }

    expect((await release(parentCookie, fixture, slotId)).status).toBe(200);
    expect((await release(parentCookie, fixture, slotId)).status).toBe(200);

    const assigned = await assign(
      ownerCookie,
      fixture,
      slotId,
      DEV_PERSONAS["second-adult"].personId,
    );
    expect(assigned.status).toBe(200);
    expect(json(assigned)).toMatchObject({
      dutySlot: { assignee: { personId: DEV_PERSONAS["second-adult"].personId } },
    });
    const unassigned = await assign(ownerCookie, fixture, slotId, null);
    expect(unassigned.status).toBe(200);
    expect(json(unassigned)).toMatchObject({ dutySlot: { id: slotId } });
    expect((json(unassigned) as { dutySlot: Record<string, unknown> }).dutySlot).not.toHaveProperty(
      "assignee",
    );

    const forbiddenCreate = await app.handle("POST", slotPath(fixture), {
      headers: { ...sameOrigin, cookie: parentCookie },
      body: { label: "Bring cups" },
    });
    const forbiddenAssign = await assign(
      parentCookie,
      fixture,
      slotId,
      DEV_PERSONAS["second-adult"].personId,
    );
    for (const response of [forbiddenCreate, forbiddenAssign]) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }

    expect((await claim(ownerCookie, fixture, slotId)).status).toBe(200);
    const cannotReleaseAnotherAdult = await release(parentCookie, fixture, slotId);
    expect(cannotReleaseAnotherAdult.status).toBe(409);
    expect(json(cannotReleaseAnotherAdult)).toMatchObject({ code: "duty_slot_taken" });
    expect(
      await config.db
        .prepare("SELECT assignee_person_id FROM duty_slots WHERE id = ?")
        .get([slotId]),
    ).toEqual({ assignee_person_id: DEV_PERSONAS.default.personId });

    await config.db
      .prepare("UPDATE adult_memberships SET status = 'revoked' WHERE person_id = ?")
      .run([DEV_PERSONAS["second-adult"].personId]);
    const cannotAssignRevokedAdult = await assign(
      ownerCookie,
      fixture,
      slotId,
      DEV_PERSONAS["second-adult"].personId,
    );
    expect(cannotAssignRevokedAdult.status).toBe(404);
    expect(json(cannotAssignRevokedAdult)).toEqual({ error: "team adult not found" });
    expect(
      await config.db
        .prepare("SELECT assignee_person_id FROM duty_slots WHERE id = ?")
        .get([slotId]),
    ).toEqual({ assignee_person_id: DEV_PERSONAS.default.personId });
  });

  it("requires authentication for every duty operation", async () => {
    const ownerCookie = await signIn();
    const fixture = await createTeamWithOccurrence(ownerCookie, "Auth Falcons");
    const slotId = await createSlot(ownerCookie, fixture);

    const responses = [
      await app.handle("GET", slotPath(fixture)),
      await app.handle("POST", slotPath(fixture), {
        headers: sameOrigin,
        body: { label: "Bring water" },
      }),
      await claim("", fixture, slotId),
      await release("", fixture, slotId),
      await assign("", fixture, slotId, null),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
  });
});

describe("duty slot scope and availability", () => {
  it("binds slots to both their team and occurrence and hides inaccessible teams", async () => {
    const ownerCookie = await signIn();
    const first = await createTeamWithOccurrence(ownerCookie, "First Falcons");
    const second = await createTeamWithOccurrence(ownerCookie, "Second Falcons");
    const parentCookie = await joinTeam(ownerCookie, first.teamId);
    const slotId = await createSlot(ownerCookie, first);

    const wrongTeam = await claim(
      ownerCookie,
      {
        teamId: second.teamId,
        occurrenceId: first.occurrenceId,
      },
      slotId,
    );
    expect(wrongTeam.status).toBe(404);
    expect(json(wrongTeam)).toEqual({ error: "event not found" });

    const wrongOccurrence = await claim(
      ownerCookie,
      { teamId: first.teamId, occurrenceId: second.occurrenceId },
      slotId,
    );
    expect(wrongOccurrence.status).toBe(404);
    expect(json(wrongOccurrence)).toEqual({ error: "event not found" });

    const hiddenTeam = await app.handle("GET", slotPath(second), {
      headers: { cookie: parentCookie },
    });
    expect(hiddenTeam.status).toBe(404);
    expect(json(hiddenTeam)).toEqual({ error: "team not found" });
  });

  it("refuses new claims for cancelled and past occurrences", async () => {
    const ownerCookie = await signIn();
    const fixture = await createTeamWithOccurrence(ownerCookie, "Timing Falcons");
    const parentCookie = await joinTeam(ownerCookie, fixture.teamId);
    const cancelledSlotId = await createSlot(ownerCookie, fixture, "Cancelled fruit");

    const cancelled = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/cancel`,
      {
        headers: { ...sameOrigin, cookie: ownerCookie },
        body: { reason: "Field closed" },
      },
    );
    expect(cancelled.status).toBe(200);
    const cancelledClaim = await claim(parentCookie, fixture, cancelledSlotId);
    expect(cancelledClaim.status).toBe(409);
    expect(json(cancelledClaim)).toMatchObject({ code: "event_occurrence_unavailable" });

    const past = await createTeamWithOccurrence(ownerCookie, "Past Falcons");
    const pastSlotId = await createSlot(ownerCookie, past, "Old fruit");
    await config.db
      .prepare("UPDATE event_occurrences SET starts_at_utc = ? WHERE id = ?")
      .run(["2000-01-01T00:00:00.000Z", past.occurrenceId]);
    const pastClaim = await claim(ownerCookie, past, pastSlotId);
    expect(pastClaim.status).toBe(409);
    expect(json(pastClaim)).toMatchObject({ code: "event_occurrence_unavailable" });
  });
});

describe("duty claim atomicity and retries", () => {
  it("allows exactly one winner when two adults claim the same slot", async () => {
    const ownerCookie = await signIn();
    const fixture = await createTeamWithOccurrence(ownerCookie, "Race Falcons");
    const parentCookie = await joinTeam(ownerCookie, fixture.teamId);
    const slotId = await createSlot(ownerCookie, fixture);

    const responses = await Promise.all([
      claim(ownerCookie, fixture, slotId),
      claim(parentCookie, fixture, slotId),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      json(responses.find((response) => response.status === 409) ?? responses[0]!),
    ).toMatchObject({ code: "duty_slot_taken" });

    const rows = (await config.db
      .prepare("SELECT assignee_person_id FROM duty_slots WHERE id = ?")
      .all([slotId])) as Array<{ assignee_person_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect([DEV_PERSONAS.default.personId, DEV_PERSONAS["second-adult"].personId]).toContain(
      rows[0]?.assignee_person_id,
    );
  });

  it("makes a winning actor's repeated claim an unchanged success", async () => {
    const ownerCookie = await signIn();
    const fixture = await createTeamWithOccurrence(ownerCookie, "Retry Falcons");
    const slotId = await createSlot(ownerCookie, fixture);

    const first = await claim(ownerCookie, fixture, slotId);
    expect(first.status).toBe(200);
    const firstSlot = (json(first) as { dutySlot: { updatedAt: string } }).dutySlot;
    const retry = await claim(ownerCookie, fixture, slotId);
    expect(retry.status).toBe(200);
    expect((json(retry) as { dutySlot: { updatedAt: string } }).dutySlot.updatedAt).toBe(
      firstSlot.updatedAt,
    );
  });
});
