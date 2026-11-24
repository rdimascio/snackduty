import type { SqlDatabase } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { batchInterference } from "./support/batch-interference";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

let interference: ReturnType<typeof batchInterference> | undefined;
const [{ default: config, services }, { DEV_PERSONAS, ensureDevelopmentPersona }] =
  await Promise.all([
    import("./support/application").then((module) =>
      module.testApplication(Date.now, {
        wrapSql: (sql) => {
          interference = batchInterference(sql);
          return interference.sql;
        },
      }),
    ),
    import("../app/lib/server/identity"),
  ]);
if (interference === undefined) throw new Error("The batch interference wrapper is not installed.");
const between = interference;

const app = await createApp(config);

const OWNER_ID = DEV_PERSONAS.default.personId;
const ADULT_ID = DEV_PERSONAS["second-adult"].personId;

async function clearState() {
  between.reset();
  await config.db.exec(
    "DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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

interface Fixture {
  ownerCookie: string;
  adultCookie: string;
  teamId: string;
  seasonId: string;
  occurrenceId: string;
  participantId: string;
}

async function buildFixture(): Promise<Fixture> {
  const ownerCookie = await signIn();
  const team = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: { name: "Guarded Falcons" },
  });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;

  const season = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      label: "Current season",
      startDate: dateDaysFromNow(-30),
      endDate: dateDaysFromNow(60),
      timeZone: "UTC",
    },
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;

  const participant = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    { headers: { ...sameOrigin, cookie: ownerCookie }, body: { displayName: "Casey Kid" } },
  );
  expect(participant.status).toBe(201);
  const participantId = (json(participant) as { participant: { participantId: string } })
    .participant.participantId;

  const event = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/events`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
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
  });
  expect(event.status).toBe(201);
  const occurrenceId =
    (json(event) as { occurrences: Array<{ id: string }> }).occurrences[0]?.id ?? "";

  await ensureDevelopmentPersona(services.db, "second-adult");
  const invitation = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "Second parent",
      recipientBinding: { kind: "confirmed_person", personId: ADULT_ID },
    },
  });
  expect(invitation.status).toBe(201);
  const token =
    (json(invitation) as { invitation: { inviteUrl: string } }).invitation.inviteUrl.split(
      "#",
    )[1] ?? "";
  const adultCookie = await signIn("second-adult");
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: adultCookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);

  return { ownerCookie, adultCookie, teamId, seasonId, occurrenceId, participantId };
}

function slotsPath(fixture: Fixture) {
  return `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/duty-slots`;
}

async function createSlot(fixture: Fixture): Promise<string> {
  const response = await app.handle("POST", slotsPath(fixture), {
    headers: { ...sameOrigin, cookie: fixture.ownerCookie },
    body: { label: "Bring fruit" },
  });
  expect(response.status).toBe(201);
  return (json(response) as { dutySlot: { id: string } }).dutySlot.id;
}

function slotAction(
  fixture: Fixture,
  cookie: string,
  slotId: string,
  action: "claim" | "release" | "assignment",
  body?: unknown,
) {
  return app.handle("POST", `${slotsPath(fixture)}/${slotId}/${action}`, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

async function assigneeOf(slotId: string) {
  const row = (await config.db
    .prepare("SELECT assignee_person_id FROM duty_slots WHERE id = ?")
    .get([slotId])) as { assignee_person_id: string | null } | undefined;
  return row?.assignee_person_id;
}

function setAssignee(slotId: string, personId: string) {
  return async (sql: SqlDatabase) => {
    await sql
      .prepare(
        "UPDATE duty_slots SET assignee_person_id = ?, assigned_by_person_id = ? WHERE id = ?",
      )
      .run([personId, personId, slotId]);
  };
}

function cancelOccurrenceRow(occurrenceId: string, reason = "Field closed") {
  return async (sql: SqlDatabase) => {
    await sql
      .prepare(
        "UPDATE event_occurrences SET status = 'cancelled', cancelled_reason = ? WHERE id = ?",
      )
      .run([reason, occurrenceId]);
  };
}

function deactivatePerson(personId: string) {
  return async (sql: SqlDatabase) => {
    await sql.prepare("UPDATE people SET status = 'inactive' WHERE id = ?").run([personId]);
  };
}

describe("duty slot guards hold when state changes between the read and the write", () => {
  it("gives two concurrent claims one 200 and one 409 and the slot one claimant", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    const responses = await Promise.all([
      slotAction(fixture, fixture.ownerCookie, slotId, "claim"),
      slotAction(fixture, fixture.adultCookie, slotId, "claim"),
    ]);

    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(json(loser ?? responses[0]!)).toMatchObject({ code: "duty_slot_taken" });
    const winner = responses.find((response) => response.status === 200);
    const winnerId = (
      json(winner ?? responses[0]!) as { dutySlot: { assignee: { personId: string } } }
    ).dutySlot.assignee.personId;
    expect(await assigneeOf(slotId)).toBe(winnerId);
  });

  it("refuses a claim when another adult claims the slot first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", setAssignee(slotId, OWNER_ID));
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "claim");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toMatchObject({ code: "duty_slot_taken" });
    expect(await assigneeOf(slotId)).toBe(OWNER_ID);
  });

  it("refuses a claim when the occurrence is cancelled first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", cancelOccurrenceRow(fixture.occurrenceId));
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "claim");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toMatchObject({ code: "event_occurrence_unavailable" });
    expect(await assigneeOf(slotId)).toBeNull();
  });

  it("refuses a claim when the claiming adult is deactivated first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", deactivatePerson(ADULT_ID));
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "claim");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(401);
    expect(json(response)).toEqual({ error: "authentication required" });
    expect(await assigneeOf(slotId)).toBeNull();
  });

  it("leaves the slot alone when a non-claimant's release lands after a reassignment", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);
    expect((await slotAction(fixture, fixture.adultCookie, slotId, "claim")).status).toBe(200);

    between.beforeNextBatch("UPDATE duty_slots", setAssignee(slotId, OWNER_ID));
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "release");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toMatchObject({ code: "duty_slot_changed" });
    expect(await assigneeOf(slotId)).toBe(OWNER_ID);
  });

  it("refuses an assignment when the slot changes first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", setAssignee(slotId, OWNER_ID));
    const response = await slotAction(fixture, fixture.ownerCookie, slotId, "assignment", {
      assigneePersonId: ADULT_ID,
    });

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toMatchObject({ code: "duty_slot_changed" });
    expect(await assigneeOf(slotId)).toBe(OWNER_ID);
  });

  it("refuses an assignment when the assignee is deactivated first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", deactivatePerson(ADULT_ID));
    const response = await slotAction(fixture, fixture.ownerCookie, slotId, "assignment", {
      assigneePersonId: ADULT_ID,
    });

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team adult not found" });
    expect(await assigneeOf(slotId)).toBeNull();
  });

  it("creates no slot when the occurrence is cancelled first", async () => {
    const fixture = await buildFixture();

    between.beforeNextBatch("INSERT INTO duty_slots", cancelOccurrenceRow(fixture.occurrenceId));
    const response = await app.handle("POST", slotsPath(fixture), {
      headers: { ...sameOrigin, cookie: fixture.ownerCookie },
      body: { label: "Bring fruit" },
    });

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toMatchObject({ code: "event_occurrence_unavailable" });
    expect(await config.db.prepare("SELECT COUNT(*) AS count FROM duty_slots").get()).toEqual({
      count: 0,
    });
  });
});

describe("attendance guards hold when state changes between the read and the write", () => {
  function record(fixture: Fixture, status: string) {
    return app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/attendance`,
      {
        headers: { ...sameOrigin, cookie: fixture.ownerCookie },
        body: { participantId: fixture.participantId, status },
      },
    );
  }

  function attendanceRows() {
    return config.db.prepare("SELECT participant_id, status FROM event_attendance").all();
  }

  it("records nothing when the child leaves the roster first", async () => {
    const fixture = await buildFixture();

    between.beforeNextBatch("INSERT INTO event_attendance", async (sql) => {
      await sql
        .prepare("UPDATE memberships SET status = 'removed' WHERE member_participant_id = ?")
        .run([fixture.participantId]);
    });
    const response = await record(fixture, "yes");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
    expect(await attendanceRows()).toEqual([]);
  });

  it("records nothing when the occurrence is cancelled first", async () => {
    const fixture = await buildFixture();

    between.beforeNextBatch(
      "INSERT INTO event_attendance",
      cancelOccurrenceRow(fixture.occurrenceId),
    );
    const response = await record(fixture, "yes");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(409);
    expect(json(response)).toEqual({ error: "event occurrence is cancelled" });
    expect(await attendanceRows()).toEqual([]);
  });

  it("keeps one row when two first answers for one child land together", async () => {
    const fixture = await buildFixture();

    const responses = await Promise.all([record(fixture, "yes"), record(fixture, "no")]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const rows = (await attendanceRows()) as Array<{ participant_id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(["yes", "no"]).toContain(rows[0]?.status);
  });
});

describe("a write refuses when the actor's access is revoked between the check and the write", () => {
  function setAdultRole(role: string) {
    return config.db
      .prepare("UPDATE adult_memberships SET role = ? WHERE person_id = ?")
      .run([role, ADULT_ID]);
  }

  function revokeAdultMembership() {
    return async (sql: SqlDatabase) => {
      await sql
        .prepare("UPDATE adult_memberships SET status = 'revoked' WHERE person_id = ?")
        .run([ADULT_ID]);
    };
  }

  function downgradeAdultToReader() {
    return async (sql: SqlDatabase) => {
      await sql
        .prepare("UPDATE adult_memberships SET role = 'adult' WHERE person_id = ?")
        .run([ADULT_ID]);
    };
  }

  function suspendAdultAccount() {
    return async (sql: SqlDatabase) => {
      await sql
        .prepare("UPDATE accounts SET status = 'suspended' WHERE person_id = ?")
        .run([ADULT_ID]);
    };
  }

  it("refuses a claim when the claimant's team membership is revoked first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);

    between.beforeNextBatch("UPDATE duty_slots", revokeAdultMembership());
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "claim");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
    expect(await assigneeOf(slotId)).toBeNull();
  });

  it("creates no slot when the coach is downgraded first", async () => {
    const fixture = await buildFixture();
    await setAdultRole("coach");

    between.beforeNextBatch("INSERT INTO duty_slots", downgradeAdultToReader());
    const response = await app.handle("POST", slotsPath(fixture), {
      headers: { ...sameOrigin, cookie: fixture.adultCookie },
      body: { label: "Bring fruit" },
    });

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
    expect(await config.db.prepare("SELECT COUNT(*) AS count FROM duty_slots").get()).toEqual({
      count: 0,
    });
  });

  it("keeps the claim when the claimant's account is suspended before the release", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);
    expect((await slotAction(fixture, fixture.adultCookie, slotId, "claim")).status).toBe(200);

    between.beforeNextBatch("UPDATE duty_slots", suspendAdultAccount());
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "release");

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(401);
    expect(json(response)).toEqual({ error: "authentication required" });
    expect(await assigneeOf(slotId)).toBe(ADULT_ID);
  });

  it("refuses an assignment when the assigning coach is downgraded first", async () => {
    const fixture = await buildFixture();
    const slotId = await createSlot(fixture);
    await setAdultRole("coach");

    between.beforeNextBatch("UPDATE duty_slots", downgradeAdultToReader());
    const response = await slotAction(fixture, fixture.adultCookie, slotId, "assignment", {
      assigneePersonId: OWNER_ID,
    });

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
    expect(await assigneeOf(slotId)).toBeNull();
  });

  it("records no attendance when the guardian edge is revoked first", async () => {
    const fixture = await buildFixture();
    const now = new Date().toISOString();
    await config.db
      .prepare(
        "INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES (?, ?, ?, 'parent', 'active', ?, ?, ?)",
      )
      .run([
        "guardian_in_flight",
        ADULT_ID,
        fixture.participantId,
        '["participant.read","participant.manage"]',
        now,
        now,
      ]);

    between.beforeNextBatch("INSERT INTO event_attendance", async (sql) => {
      await sql
        .prepare("UPDATE guardian_relationships SET status = 'revoked' WHERE id = ?")
        .run(["guardian_in_flight"]);
    });
    const response = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/attendance`,
      {
        headers: { ...sameOrigin, cookie: fixture.adultCookie },
        body: { participantId: fixture.participantId, status: "yes" },
      },
    );

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
    expect(await config.db.prepare("SELECT COUNT(*) AS count FROM event_attendance").get()).toEqual(
      { count: 0 },
    );
  });

  it("leaves the occurrence scheduled when the cancelling coach is downgraded first", async () => {
    const fixture = await buildFixture();
    await setAdultRole("coach");

    between.beforeNextBatch("UPDATE event_occurrences", downgradeAdultToReader());
    const response = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/cancel`,
      { headers: { ...sameOrigin, cookie: fixture.adultCookie }, body: { reason: "Rain" } },
    );

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
    expect(
      await config.db
        .prepare("SELECT status, cancelled_reason FROM event_occurrences WHERE id = ?")
        .get([fixture.occurrenceId]),
    ).toEqual({ status: "scheduled", cancelled_reason: null });
  });
});

describe("cancel occurrence guard holds when another cancel lands first", () => {
  it("keeps the first human reason", async () => {
    const fixture = await buildFixture();

    between.beforeNextBatch(
      "event_occurrences",
      cancelOccurrenceRow(fixture.occurrenceId, "Field closed"),
    );
    const response = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/cancel`,
      { headers: { ...sameOrigin, cookie: fixture.ownerCookie }, body: { reason: "Rain" } },
    );

    expect(between.firedCount()).toBe(1);
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({
      occurrence: { status: "cancelled", cancelledReason: "Field closed" },
    });
    expect(
      await config.db
        .prepare("SELECT cancelled_reason FROM event_occurrences WHERE id = ?")
        .get([fixture.occurrenceId]),
    ).toEqual({ cancelled_reason: "Field closed" });
  });
});
