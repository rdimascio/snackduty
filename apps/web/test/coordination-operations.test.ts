import { createApp } from "@lesto/kernel";
import { eq } from "@lesto/db";
import {
  attendanceReadResponseSchema,
  createEventResponseSchema,
  dutySlotResponseSchema,
  seasonEventsResponseSchema,
} from "@snackday/domain";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const now = Date.parse("2029-01-10T12:00:00.000Z");
const [{ default: config, services }, server] = await Promise.all([
  import("./support/application").then((module) => module.testApplication(() => now)),
  Promise.all([
    import("../app/lib/server/coordination-operations"),
    import("../app/lib/server/identity"),
    import("../app/lib/server/teams"),
    import("../app/lib/server/roster"),
  ]),
]);
await createApp(config);

const [{ createCoordinationOperations }, identity, teamTables, rosterTables] = server;
const operations = createCoordinationOperations({ db: services.db, clock: () => now });

async function clearState() {
  await config.db.exec(
    "DELETE FROM event_creation_receipts; DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM verified_identity_emails; DELETE FROM adult_consents; DELETE FROM provider_identity_links; DELETE FROM authentication_challenges; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

const ownerActor = {
  accountId: identity.DEV_PERSONAS.default.accountId,
  personId: identity.DEV_PERSONAS.default.personId,
};
const secondActor = {
  accountId: identity.DEV_PERSONAS["second-adult"].accountId,
  personId: identity.DEV_PERSONAS["second-adult"].personId,
};

async function fixture() {
  await identity.ensureDevelopmentPersona(services.db, "default");
  await identity.ensureDevelopmentPersona(services.db, "second-adult");
  const createdAt = new Date(now).toISOString();
  await services.db
    .insert(teamTables.teams)
    .values({
      id: "team_coordination",
      name: "Coordination Falcons",
      status: "active",
      createdByPersonId: ownerActor.personId,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  await services.db
    .insert(teamTables.seasons)
    .values({
      id: "season_coordination",
      teamId: "team_coordination",
      label: "Spring 2029",
      startDate: "2029-01-01",
      endDate: "2029-06-01",
      timeZone: "UTC",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  await services.db
    .insert(teamTables.adultMemberships)
    .values({
      id: "adult_membership_second",
      teamId: "team_coordination",
      personId: secondActor.personId,
      role: "adult",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    })
    .run();

  for (const child of [
    { personId: "person_child_a", participantId: "participant_child_a", name: "Avery Child" },
    { personId: "person_child_b", participantId: "participant_child_b", name: "Bailey Child" },
  ]) {
    await services.db
      .insert(identity.people)
      .values({
        id: child.personId,
        displayName: child.name,
        status: "active",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    await services.db
      .insert(rosterTables.participants)
      .values({
        id: child.participantId,
        personId: child.personId,
        birthDate: null,
        status: "active",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    await services.db
      .insert(rosterTables.memberships)
      .values({
        id: `membership_${child.participantId}`,
        teamId: "team_coordination",
        seasonId: "season_coordination",
        memberKind: "participant",
        memberPersonId: null,
        memberParticipantId: child.participantId,
        status: "active",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }
  await services.db
    .insert(rosterTables.guardianRelationships)
    .values({
      id: "guardian_second_a",
      guardianPersonId: secondActor.personId,
      participantId: "participant_child_a",
      relationship: "parent",
      status: "active",
      permissions: JSON.stringify(["participant.read", "participant.manage"]),
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  return { teamId: "team_coordination", seasonId: "season_coordination" };
}

const eventInput = {
  title: "Saturday game",
  kind: "game" as const,
  schedule: {
    timeZone: "UTC",
    localTime: "12:00",
    durationMinutes: 60,
    frequency: "once" as const,
    startDate: "2029-02-03",
  },
  requestId: "6f0f8629-8cdb-4d1e-85c4-f87bd493a6f8",
  snackDuty: { label: "Bring fruit", instructions: "Enough for twelve players" },
};

describe("coordination application operations", () => {
  it("creates event and snack atomically and makes concurrent requestId retries one creation", async () => {
    const target = await fixture();
    const [first, retry] = await Promise.all([
      operations.createEvent(ownerActor, { ...target, input: eventInput }),
      operations.createEvent(ownerActor, { ...target, input: eventInput }),
    ]);
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) throw new Error("Expected both event creates to succeed.");
    expect(createEventResponseSchema.parse(first.value)).toEqual(
      createEventResponseSchema.parse(retry.value),
    );
    expect(first.value.dutySlots).toHaveLength(1);
    expect(await config.db.prepare("SELECT COUNT(*) AS count FROM event_series").get()).toEqual({
      count: 1,
    });
    expect(
      await config.db.prepare("SELECT COUNT(*) AS count FROM event_occurrences").get(),
    ).toEqual({ count: 1 });
    expect(await config.db.prepare("SELECT COUNT(*) AS count FROM duty_slots").get()).toEqual({
      count: 1,
    });
    expect(
      await config.db.prepare("SELECT COUNT(*) AS count FROM event_creation_receipts").get(),
    ).toEqual({ count: 1 });

    const conflict = await operations.createEvent(ownerActor, {
      ...target,
      input: { ...eventInput, title: "Different event" },
    });
    expect(conflict).toMatchObject({
      ok: false,
      status: 409,
      body: { code: "request_id_conflict" },
    });
  });

  it("rolls back both resources when a new snack assignment is unavailable", async () => {
    const target = await fixture();
    const unavailable = await operations.createEvent(ownerActor, {
      ...target,
      input: {
        ...eventInput,
        requestId: "67977acf-b29a-4a64-8a45-1ed31742d0d0",
        schedule: { ...eventInput.schedule, startDate: "2028-12-01" },
      },
    });
    expect(unavailable).toMatchObject({
      ok: false,
      status: 409,
      body: { code: "event_occurrence_unavailable" },
    });
    for (const table of [
      "event_series",
      "event_occurrences",
      "duty_slots",
      "event_creation_receipts",
    ]) {
      expect(await config.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
  });

  it("validates the exact account/person pair and current account status", async () => {
    const target = await fixture();
    const mismatched = await operations.listSeasonEvents(
      { accountId: ownerActor.accountId, personId: secondActor.personId },
      target,
    );
    expect(mismatched).toMatchObject({
      ok: false,
      status: 401,
      body: { code: "authentication_required" },
    });

    await services.db
      .update(identity.accounts)
      .set({ status: "revoked" })
      .where(eq(identity.accounts.id, ownerActor.accountId))
      .run();
    const revoked = await operations.listSeasonEvents(ownerActor, target);
    expect(revoked).toMatchObject({
      ok: false,
      status: 401,
      body: { code: "authentication_required" },
    });
  });

  it("grants co-coach operations only on the independently authorized team", async () => {
    const target = await fixture();
    await services.db
      .update(teamTables.adultMemberships)
      .set({ role: "coach" })
      .where(eq(teamTables.adultMemberships.id, "adult_membership_second"))
      .run();
    const created = await operations.createEvent(secondActor, {
      ...target,
      input: { ...eventInput, requestId: "a37fb568-65fc-454a-9ce8-3f6c693a940d" },
    });
    expect(created.ok).toBe(true);

    const other = await services.db
      .insert(teamTables.teams)
      .values({
        id: "team_other",
        name: "Other Falcons",
        status: "active",
        createdByPersonId: ownerActor.personId,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })
      .returning()
      .get();
    await services.db
      .insert(teamTables.seasons)
      .values({
        id: "season_other",
        teamId: other.id,
        label: "Other season",
        startDate: "2029-01-01",
        endDate: "2029-06-01",
        timeZone: "UTC",
        status: "active",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })
      .run();
    expect(
      await operations.createEvent(secondActor, {
        teamId: other.id,
        seasonId: "season_other",
        input: { ...eventInput, requestId: "5fec95c5-a73a-41e3-bada-c39504612153" },
      }),
    ).toMatchObject({ ok: false, status: 404, body: { code: "team_not_found" } });
  });

  it("projects only an own-child RSVP option and reauthorizes the write", async () => {
    const target = await fixture();
    const created = await operations.createEvent(ownerActor, { ...target, input: eventInput });
    if (!created.ok) throw new Error("Expected event creation to succeed.");
    const occurrenceId = created.value.occurrences[0]?.id ?? "";

    const initial = await operations.readAttendance(secondActor, {
      teamId: target.teamId,
      occurrenceId,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error("Expected attendance read to succeed.");
    expect(attendanceReadResponseSchema.parse(initial.value).attendance.responseOptions).toEqual([
      { participantId: "participant_child_a", displayName: "Avery Child" },
    ]);

    expect(
      await operations.recordAttendance(secondActor, {
        teamId: target.teamId,
        occurrenceId,
        input: { participantId: "participant_child_b", status: "yes" },
      }),
    ).toMatchObject({ ok: false, status: 404, body: { code: "participant_not_found" } });
    const recorded = await operations.recordAttendance(secondActor, {
      teamId: target.teamId,
      occurrenceId,
      input: { participantId: "participant_child_a", status: "yes" },
    });
    expect(recorded).toMatchObject({ ok: true, value: { attendance: { status: "yes" } } });
    const after = await operations.readAttendance(secondActor, {
      teamId: target.teamId,
      occurrenceId,
    });
    expect(after).toMatchObject({
      ok: true,
      value: { attendance: { responseOptions: [{ status: "yes" }] } },
    });
  });

  it("lists one selected season and allows only one adult to win a snack claim", async () => {
    const target = await fixture();
    const created = await operations.createEvent(ownerActor, { ...target, input: eventInput });
    if (!created.ok) throw new Error("Expected event creation to succeed.");
    const occurrenceId = created.value.occurrences[0]?.id ?? "";
    const slotId = created.value.dutySlots[0]?.id ?? "";

    const listed = await operations.listSeasonEvents(secondActor, target);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(seasonEventsResponseSchema.parse(listed.value).events).toHaveLength(1);
    const duties = await operations.listDutySlots(secondActor, {
      teamId: target.teamId,
      occurrenceId,
    });
    expect(duties).toMatchObject({ ok: true, value: { dutySlots: [{ id: slotId }] } });

    const claims = await Promise.all([
      operations.claimDutySlot(ownerActor, { teamId: target.teamId, occurrenceId, slotId }),
      operations.claimDutySlot(secondActor, { teamId: target.teamId, occurrenceId, slotId }),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toEqual([
      expect.objectContaining({
        status: 409,
        body: expect.objectContaining({ code: "duty_slot_taken" }),
      }),
    ]);
    const winner = claims.find((claim) => claim.ok);
    if (winner?.ok)
      expect(dutySlotResponseSchema.parse(winner.value).dutySlot.assignee).toBeDefined();
  });
});
