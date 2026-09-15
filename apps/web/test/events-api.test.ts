import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config, services } = await import("./support/application").then((module) =>
  module.testApplication(),
);
const { DEV_PERSONAS, ensureDevelopmentPersona } = await import("../app/lib/server/identity");
const { RESCHEDULE_CANCEL_REASON } = await import("../app/lib/server/events");
const { weekdayOf } = await import("../app/lib/server/event-time");

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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

async function createTeamAndSeason(cookie: string): Promise<{ teamId: string; seasonId: string }> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Events Falcons" },
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

// A weekly Tuesday practice whose range CROSSES the 2026-03-08 America/
// Los_Angeles spring-forward: same 17:00 wall time, different UTC instants.
const weeklyPractice = {
  title: "Tuesday Practice",
  kind: "practice",
  location: "Riverside Park, Field 2",
  notes: "Bring water",
  schedule: {
    timeZone: "America/Los_Angeles",
    localTime: "17:00",
    durationMinutes: 60,
    frequency: "weekly",
    byWeekday: ["tuesday"],
    startDate: "2026-03-03",
    untilDate: "2026-03-17",
  },
} as const;

function createSeries(
  cookie: string,
  teamId: string,
  seasonId: string,
  body: unknown = weeklyPractice,
) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/events`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function updateSeries(cookie: string, teamId: string, seriesId: string, body: unknown) {
  return app.handle("POST", `/api/teams/${teamId}/events/${seriesId}/update`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function cancelOccurrence(cookie: string, teamId: string, occurrenceId: string, reason: string) {
  return app.handle("POST", `/api/teams/${teamId}/occurrences/${occurrenceId}/cancel`, {
    headers: { ...sameOrigin, cookie },
    body: { reason },
  });
}

function listEvents(cookie: string, teamId: string) {
  return app.handle("GET", `/api/teams/${teamId}/events`, { headers: { cookie } });
}

interface OccurrenceProjection {
  id: string;
  seriesId: string;
  localDate: string;
  startsAt: string;
  durationMinutes: number;
  status: string;
  cancelledReason?: string;
}

function createdOccurrences(response: { body: string }): OccurrenceProjection[] {
  return (json(response) as { occurrences: OccurrenceProjection[] }).occurrences;
}

// Reconcile compares instants against the wall clock, so "past" and "future"
// have to be real — every schedule-edit fixture is dated relative to today, and
// the suite never goes stale.
const dayMs = 24 * 60 * 60 * 1_000;
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * dayMs).toISOString().slice(0, 10);
}

/** A weekly schedule on `byWeekday`, otherwise identical run to run. */
function weeklyOn(byWeekday: string[], startDate: string, untilDate: string) {
  return {
    timeZone: "America/Los_Angeles",
    localTime: "17:00",
    durationMinutes: 60,
    frequency: "weekly",
    byWeekday,
    startDate,
    untilDate,
  };
}

/** Join a second adult onto the team as a READ-ONLY member via the real flow. */
async function joinReadOnlyMember(ownerCookie: string, teamId: string): Promise<string> {
  await ensureDevelopmentPersona(services.db, "second-adult");
  const invited = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "the second adult",
      recipientBinding: {
        kind: "confirmed_person",
        personId: DEV_PERSONAS["second-adult"].personId,
      },
    },
  });
  expect(invited.status).toBe(201);
  const inviteUrl = (json(invited) as { invitation: { inviteUrl: string } }).invitation.inviteUrl;
  const token = inviteUrl.split("#")[1] ?? "";

  const memberCookie = await signIn("second-adult");
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: memberCookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

describe("event series creation", () => {
  it("materializes every occurrence with wall-time-correct instants across DST", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const created = await createSeries(cookie, teamId, seasonId);
    expect(created.status).toBe(201);
    const body = json(created) as { series: Record<string, unknown>; occurrences: unknown[] };
    expect(body.series).toMatchObject({
      teamId,
      seasonId,
      title: "Tuesday Practice",
      kind: "practice",
      location: "Riverside Park, Field 2",
      notes: "Bring water",
      timeZone: "America/Los_Angeles",
      localTime: "17:00",
      durationMinutes: 60,
      frequency: "weekly",
      byWeekday: ["tuesday"],
      startDate: "2026-03-03",
      untilDate: "2026-03-17",
      status: "active",
    });

    const occurrences = createdOccurrences(created);
    expect(occurrences.map((occurrence) => occurrence.localDate)).toEqual([
      "2026-03-03",
      "2026-03-10",
      "2026-03-17",
    ]);
    // 17:00 PST is 01:00Z next day; after the 2026-03-08 spring-forward,
    // 17:00 PDT is 00:00Z — 5:00pm stays 5:00pm local, so the instants move.
    expect(occurrences.map((occurrence) => occurrence.startsAt)).toEqual([
      "2026-03-04T01:00:00.000Z",
      "2026-03-11T00:00:00.000Z",
      "2026-03-18T00:00:00.000Z",
    ]);
    for (const occurrence of occurrences) {
      expect(occurrence.status).toBe("scheduled");
      expect(occurrence.id).toStartWith("event_occurrence_");
    }

    // Fall-back coverage through the API too: a weekly Tuesday series across
    // 2026-11-01 gains an hour of UTC offset while staying 17:00 local.
    const fall = await createSeries(cookie, teamId, seasonId, {
      title: "Late Fall Practice",
      kind: "practice",
      schedule: { ...weeklyPractice.schedule, startDate: "2026-10-27", untilDate: "2026-11-03" },
    });
    expect(fall.status).toBe(201);
    expect(createdOccurrences(fall).map((occurrence) => occurrence.startsAt)).toEqual([
      "2026-10-28T00:00:00.000Z",
      "2026-11-04T01:00:00.000Z",
    ]);

    const serialized = created.body.toLowerCase();
    for (const forbidden of ["person_", "account", "token", "createdbypersonid", "email"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("creates a single occurrence for a once schedule", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const created = await createSeries(cookie, teamId, seasonId, {
      title: "Season Opener",
      kind: "game",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "10:00",
        durationMinutes: 90,
        frequency: "once",
        startDate: "2026-04-11",
      },
    });
    expect(created.status).toBe(201);
    const occurrences = createdOccurrences(created);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      localDate: "2026-04-11",
      startsAt: "2026-04-11T17:00:00.000Z",
      durationMinutes: 90,
      status: "scheduled",
    });
  });

  it("refuses unusable schedules with coded 422s and writes nothing", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const badZone = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: { ...weeklyPractice.schedule, timeZone: "Not/AZone" },
    });
    expect(badZone.status).toBe(422);
    expect(json(badZone)).toMatchObject({ code: "unknown_time_zone" });

    const emptyRange = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: {
        ...weeklyPractice.schedule,
        byWeekday: ["monday"],
        startDate: "2026-03-03",
        untilDate: "2026-03-06",
      },
    });
    expect(emptyRange.status).toBe(422);
    expect(json(emptyRange)).toMatchObject({ code: "no_occurrences" });

    const tooMany = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: {
        ...weeklyPractice.schedule,
        byWeekday: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        startDate: "2026-01-01",
        untilDate: "2026-12-31",
      },
    });
    expect(tooMany.status).toBe(422);
    expect(json(tooMany)).toMatchObject({ code: "too_many_occurrences" });

    expect(await config.db.prepare("SELECT id FROM event_series").all()).toEqual([]);
    expect(await config.db.prepare("SELECT id FROM event_occurrences").all()).toEqual([]);
  });

  it("rejects schedules the domain schema refuses", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const invalidSchedules = [
      // weekly without untilDate
      { ...weeklyPractice.schedule, untilDate: undefined },
      // weekly without byWeekday
      { ...weeklyPractice.schedule, byWeekday: undefined },
      // once with weekday selection
      {
        timeZone: "UTC",
        localTime: "10:00",
        durationMinutes: 60,
        frequency: "once",
        startDate: "2026-04-11",
        byWeekday: ["monday"],
      },
      // malformed wall time
      { ...weeklyPractice.schedule, localTime: "5pm" },
      // until precedes start
      { ...weeklyPractice.schedule, startDate: "2026-03-17", untilDate: "2026-03-03" },
    ];
    for (const schedule of invalidSchedules) {
      await expect(
        createSeries(cookie, teamId, seasonId, { ...weeklyPractice, schedule }),
      ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    }
    expect(await config.db.prepare("SELECT id FROM event_series").all()).toEqual([]);
  });

  it("authorizes creation: 401 signed out, 404-hidden for non-managers", async () => {
    const unauthenticated = await createSeries("", "team_missing", "season_missing");
    expect(unauthenticated.status).toBe(401);

    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const memberCookie = await joinReadOnlyMember(ownerCookie, teamId);

    // A read-only adult member is hidden from management like a stranger.
    const asMember = await createSeries(memberCookie, teamId, seasonId);
    expect(asMember.status).toBe(404);
    expect(json(asMember)).toEqual({ error: "team not found" });

    const crossSite = await app.handle(`POST`, `/api/teams/${teamId}/seasons/${seasonId}/events`, {
      headers: { "sec-fetch-site": "cross-site", cookie: ownerCookie },
      body: weeklyPractice,
    });
    expect(crossSite.status).toBe(403);

    expect(await config.db.prepare("SELECT id FROM event_series").all()).toEqual([]);
  });
});

describe("schedule bounds", () => {
  const everyWeekday = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];

  it("answers a coded refusal at the far end of the calendar, on create and on edit", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    // 9999-12-31 is a Friday, so a Monday schedule that day names nothing —
    // but the walk has to step PAST 9999-12-31 to find that out, and that
    // step is what used to leave the calendar and answer a 500.
    const endOfCalendar = weeklyOn(["monday"], "9999-12-31", "9999-12-31");

    const created = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: endOfCalendar,
    });
    expect(created.status).toBe(422);
    expect(json(created)).toMatchObject({ code: "no_occurrences" });

    const series = await createSeries(cookie, teamId, seasonId);
    const seriesId = (json(series) as { series: { id: string } }).series.id;
    const updated = await updateSeries(cookie, teamId, seriesId, {
      ...weeklyPractice,
      schedule: endOfCalendar,
    });
    expect(updated.status).toBe(422);
    expect(json(updated)).toMatchObject({ code: "no_occurrences" });
    expect(createdOccurrences(series)).toHaveLength(3);
  });

  it("refuses an over-cap schedule for a cost independent of how wide it is", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const refuse = async (untilDate: string): Promise<number> => {
      const started = performance.now();
      const refused = await createSeries(cookie, teamId, seasonId, {
        ...weeklyPractice,
        schedule: weeklyOn(everyWeekday, "2026-01-01", untilDate),
      });
      const elapsed = performance.now() - started;
      expect(refused.status).toBe(422);
      expect(json(refused)).toMatchObject({ code: "too_many_occurrences" });
      return elapsed;
    };

    await refuse("2027-12-31");
    const twoYears = await refuse("2027-12-31");
    const eightThousandYears = await refuse("9998-12-31");

    // An absolute ceiling states the promise, but a fast machine can walk the
    // whole range inside it — the RELATIVE bound is what bites. Both refusals
    // stop after the same ~200 dates, so a range four thousand times wider may
    // not cost meaningfully more. Uncapped it walks 2.9 million civil days of
    // synchronous, un-preemptible event-loop time, before authorization runs.
    expect(eightThousandYears).toBeLessThan(100);
    expect(eightThousandYears).toBeLessThan(twoYears * 4 + 10);
  });

  it("accepts exactly the occurrence cap and refuses one more", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    // 2026-01-01 through 2026-07-19 inclusive is 200 days; one day more is 201.
    const atCap = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: weeklyOn(everyWeekday, "2026-01-01", "2026-07-19"),
    });
    expect(atCap.status).toBe(201);
    expect(createdOccurrences(atCap)).toHaveLength(200);

    const overCap = await createSeries(cookie, teamId, seasonId, {
      ...weeklyPractice,
      schedule: weeklyOn(everyWeekday, "2026-01-01", "2026-07-20"),
    });
    expect(overCap.status).toBe(422);
    expect(json(overCap)).toMatchObject({ code: "too_many_occurrences" });
  });
});

describe("event listing", () => {
  it("shows series and occurrences to every team reader, hidden from strangers", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    await createSeries(ownerCookie, teamId, seasonId);
    const memberCookie = await joinReadOnlyMember(ownerCookie, teamId);

    const asMember = await listEvents(memberCookie, teamId);
    expect(asMember.status).toBe(200);
    const events = (
      json(asMember) as { events: { series: { title: string }; occurrences: unknown[] }[] }
    ).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.series.title).toBe("Tuesday Practice");
    expect(events[0]?.occurrences).toHaveLength(3);
    expect(events[0]?.occurrences[0]).toMatchObject({ attendance: { yes: 0, no: 0, maybe: 0 } });

    // A stranger (fresh second team owner without membership) is hidden.
    await clearState();
    const strangerCookie = await signIn("second-adult");
    const rebuiltOwner = await signIn();
    const rebuilt = await createTeamAndSeason(rebuiltOwner);
    await createSeries(rebuiltOwner, rebuilt.teamId, rebuilt.seasonId);
    const hidden = await listEvents(strangerCookie, rebuilt.teamId);
    expect(hidden.status).toBe(404);
    expect(json(hidden)).toEqual({ error: "team not found" });
  });

  it("hides archived-season events and denies mutations after an archive", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const created = await createSeries(cookie, teamId, seasonId);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const occurrenceId = createdOccurrences(created)[0]?.id ?? "";

    expect((json(await listEvents(cookie, teamId)) as { events: unknown[] }).events).toHaveLength(
      1,
    );
    await config.db.prepare("UPDATE seasons SET status = 'archived' WHERE id = ?").run([seasonId]);

    expect((json(await listEvents(cookie, teamId)) as { events: unknown[] }).events).toEqual([]);
    const createAfterArchive = await createSeries(cookie, teamId, seasonId);
    expect(createAfterArchive.status).toBe(404);
    expect(json(createAfterArchive)).toEqual({ error: "team not found" });

    const updateAfterArchive = await updateSeries(cookie, teamId, seriesId, weeklyPractice);
    expect(updateAfterArchive.status).toBe(404);
    expect(json(updateAfterArchive)).toEqual({ error: "event not found" });
    const cancelAfterArchive = await cancelOccurrence(cookie, teamId, occurrenceId, "Too late");
    expect(cancelAfterArchive.status).toBe(404);
    expect(json(cancelAfterArchive)).toEqual({ error: "event not found" });

    expect(
      await config.db.prepare("SELECT title FROM event_series WHERE id = ?").get([seriesId]),
    ).toEqual({ title: "Tuesday Practice" });
    expect(
      await config.db
        .prepare("SELECT status FROM event_occurrences WHERE id = ?")
        .get([occurrenceId]),
    ).toEqual({ status: "scheduled" });
  });

  it("rejects a series whose season belongs to another team", async () => {
    const cookie = await signIn();
    const first = await createTeamAndSeason(cookie);
    const second = await createTeamAndSeason(cookie);
    const created = await createSeries(cookie, first.teamId, first.seasonId);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const occurrenceId = createdOccurrences(created)[0]?.id ?? "";

    await config.db
      .prepare("UPDATE event_series SET season_id = ? WHERE id = ?")
      .run([second.seasonId, seriesId]);

    expect((json(await listEvents(cookie, first.teamId)) as { events: unknown[] }).events).toEqual(
      [],
    );
    expect((await updateSeries(cookie, first.teamId, seriesId, weeklyPractice)).status).toBe(404);
    expect(
      (await cancelOccurrence(cookie, first.teamId, occurrenceId, "Invalid scope")).status,
    ).toBe(404);
  });
});

describe("occurrence cancellation", () => {
  it("cancels with a reason, stays visible, and re-cancelling is a no-op", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const created = await createSeries(cookie, teamId, seasonId);
    const target = createdOccurrences(created)[1];
    if (target === undefined) throw new Error("fixture: the series has no second occurrence.");

    const cancelled = await cancelOccurrence(cookie, teamId, target.id, "Field flooded");
    expect(cancelled.status).toBe(200);
    expect((json(cancelled) as { occurrence: OccurrenceProjection }).occurrence).toMatchObject({
      id: target.id,
      status: "cancelled",
      cancelledReason: "Field flooded",
    });

    const again = await cancelOccurrence(cookie, teamId, target.id, "Different reason");
    expect(again.status).toBe(200);
    expect((json(again) as { occurrence: OccurrenceProjection }).occurrence).toMatchObject({
      status: "cancelled",
      cancelledReason: "Field flooded",
    });

    // History is not rewritten: the occurrence is still listed, cancelled,
    // with its reason, alongside its scheduled siblings.
    const listed = await listEvents(cookie, teamId);
    const occurrences = (json(listed) as { events: { occurrences: OccurrenceProjection[] }[] })
      .events[0]?.occurrences;
    expect(occurrences).toHaveLength(3);
    expect(occurrences?.filter((occurrence) => occurrence.status === "cancelled")).toEqual([
      expect.objectContaining({ id: target.id, cancelledReason: "Field flooded" }),
    ]);
  });

  it("refuses the reason reserved for schedule changes", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const created = await createSeries(cookie, teamId, seasonId);
    const target = createdOccurrences(created)[0];
    if (target === undefined) throw new Error("fixture: the series materialized no occurrences.");

    // A human allowed to write the machine's reason would have their
    // cancellation reinstated by the next schedule edit naming this date.
    const refused = await cancelOccurrence(cookie, teamId, target.id, RESCHEDULE_CANCEL_REASON);
    expect(refused.status).toBe(422);
    expect(json(refused)).toMatchObject({ code: "reserved_cancellation_reason" });
    // Padding is trimmed before the comparison, so it is not a way past it.
    const padded = await cancelOccurrence(
      cookie,
      teamId,
      target.id,
      `  ${RESCHEDULE_CANCEL_REASON}  `,
    );
    expect(padded.status).toBe(422);

    expect(
      await config.db
        .prepare("SELECT status, cancelled_reason FROM event_occurrences WHERE id = ?")
        .get([target.id]),
    ).toEqual({ status: "scheduled", cancelled_reason: null });
  });

  it("hides cancellation from non-managers and unknown occurrences alike", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const created = await createSeries(ownerCookie, teamId, seasonId);
    const target = createdOccurrences(created)[0];
    if (target === undefined) throw new Error("fixture: the series materialized no occurrences.");
    const memberCookie = await joinReadOnlyMember(ownerCookie, teamId);

    const asMember = await cancelOccurrence(memberCookie, teamId, target.id, "Nope");
    expect(asMember.status).toBe(404);
    expect(json(asMember)).toEqual({ error: "team not found" });

    const unknown = await cancelOccurrence(ownerCookie, teamId, "event_occurrence_missing", "?");
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toEqual({ error: "event not found" });

    const stillScheduled = await config.db
      .prepare("SELECT status FROM event_occurrences WHERE id = ?")
      .get([target.id]);
    expect(stillScheduled).toEqual({ status: "scheduled" });
  });
});

describe("series schedule edits", () => {
  it("keeps occurrence identity, attendance, and cancellations while recomputing instants", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const addedChild = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      { headers: { ...sameOrigin, cookie }, body: { displayName: "Casey Kid" } },
    );
    const participantId = (json(addedChild) as { participant: { participantId: string } })
      .participant.participantId;

    const created = await createSeries(cookie, teamId, seasonId);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const before = createdOccurrences(created);
    const second = before[1];
    const third = before[2];
    if (second === undefined || third === undefined) {
      throw new Error("fixture: the series materialized fewer than three occurrences.");
    }

    const recorded = await app.handle(
      "POST",
      `/api/teams/${teamId}/occurrences/${second.id}/attendance`,
      { headers: { ...sameOrigin, cookie }, body: { participantId, status: "yes" } },
    );
    expect(recorded.status).toBe(200);
    expect((await cancelOccurrence(cookie, teamId, third.id, "Coach away")).status).toBe(200);

    // Same Tuesdays, one week longer, moved to 17:30.
    const updated = await updateSeries(cookie, teamId, seriesId, {
      ...weeklyPractice,
      title: "Tuesday Practice (moved)",
      schedule: { ...weeklyPractice.schedule, localTime: "17:30", untilDate: "2026-03-24" },
    });
    expect(updated.status).toBe(200);
    const after = createdOccurrences(updated);
    expect(after.map((occurrence) => occurrence.localDate)).toEqual([
      "2026-03-03",
      "2026-03-10",
      "2026-03-17",
      "2026-03-24",
    ]);
    // Kept dates keep their occurrence IDs — attendance stays attached.
    expect(after.slice(0, 3).map((occurrence) => occurrence.id)).toEqual(
      before.map((occurrence) => occurrence.id),
    );
    // Instants recomputed for the new wall time, still DST-correct.
    expect(after.map((occurrence) => occurrence.startsAt)).toEqual([
      "2026-03-04T01:30:00.000Z",
      "2026-03-11T00:30:00.000Z",
      "2026-03-18T00:30:00.000Z",
      "2026-03-25T00:30:00.000Z",
    ]);
    // The cancelled occurrence stays cancelled with ITS reason.
    expect(after[2]).toMatchObject({ status: "cancelled", cancelledReason: "Coach away" });

    const attendanceRows = await config.db
      .prepare("SELECT occurrence_id, participant_id, status FROM event_attendance")
      .all();
    expect(attendanceRows).toEqual([
      { occurrence_id: second.id, participant_id: participantId, status: "yes" },
    ]);

    // Replaying the same definition changes nothing — no duplicates, same ids.
    const replayed = await updateSeries(cookie, teamId, seriesId, {
      ...weeklyPractice,
      title: "Tuesday Practice (moved)",
      schedule: { ...weeklyPractice.schedule, localTime: "17:30", untilDate: "2026-03-24" },
    });
    expect(createdOccurrences(replayed).map((occurrence) => occurrence.id)).toEqual(
      after.map((occurrence) => occurrence.id),
    );
  });

  it("cancels FUTURE occurrences a schedule change drops and leaves past ones alone", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    // Five occurrences on one weekday: two clearly past, three clearly future
    // (today excluded).
    const start = isoDaysFromNow(-16);
    const until = isoDaysFromNow(+12);
    const weekday = weekdayOf(start);
    const droppedDates = [-16, -9, -2, 5, 12].map((offset) => isoDaysFromNow(offset));

    const created = await createSeries(cookie, teamId, seasonId, {
      title: "Weekly Scrimmage",
      kind: "game",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "09:00",
        durationMinutes: 60,
        frequency: "weekly",
        byWeekday: [weekday],
        startDate: start,
        untilDate: until,
      },
    });
    expect(created.status).toBe(201);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    expect(createdOccurrences(created).map((occurrence) => occurrence.localDate)).toEqual(
      droppedDates,
    );

    // Move the series to the NEXT weekday: every old-weekday date leaves the
    // schedule.
    const newWeekday = weekdayOf(isoDaysFromNow(-15));
    const updated = await updateSeries(cookie, teamId, seriesId, {
      title: "Weekly Scrimmage",
      kind: "game",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "09:00",
        durationMinutes: 60,
        frequency: "weekly",
        byWeekday: [newWeekday],
        startDate: start,
        untilDate: until,
      },
    });
    expect(updated.status).toBe(200);

    const after = createdOccurrences(updated);
    const byDate = new Map(after.map((occurrence) => [occurrence.localDate, occurrence] as const));
    // Past dropped dates: untouched history, still scheduled.
    for (const date of droppedDates.slice(0, 2)) {
      expect(byDate.get(date)).toMatchObject({ status: "scheduled" });
    }
    // The date two days ago is also past — reconcile compares instants.
    expect(byDate.get(droppedDates[2] ?? "")).toMatchObject({ status: "scheduled" });
    // Future dropped dates: cancelled with the reserved reason, not deleted.
    for (const date of droppedDates.slice(3)) {
      expect(byDate.get(date)).toMatchObject({
        status: "cancelled",
        cancelledReason: RESCHEDULE_CANCEL_REASON,
      });
    }
    // New-weekday dates materialized: -15, -8, -1, +6 (four of them).
    const newDates = after
      .filter((occurrence) => weekdayOf(occurrence.localDate) === newWeekday)
      .map((occurrence) => occurrence.localDate);
    expect(newDates).toHaveLength(4);
    expect(byDate.size).toBe(after.length);
  });

  it("restores dates a previous edit dropped, with their ids and attendance", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const addedChild = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      { headers: { ...sameOrigin, cookie }, body: { displayName: "Casey Kid" } },
    );
    const participantId = (json(addedChild) as { participant: { participantId: string } })
      .participant.participantId;

    const start = isoDaysFromNow(7);
    const until = isoDaysFromNow(35);
    const kept = weekdayOf(start);
    const dropped = weekdayOf(isoDaysFromNow(8));
    const twoDays = { title: "Two-day Practice", kind: "practice" };
    const created = await createSeries(cookie, teamId, seasonId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(created.status).toBe(201);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const before = createdOccurrences(created);
    const onDroppedDay = before.filter((occurrence) => weekdayOf(occurrence.localDate) === dropped);
    const attended = onDroppedDay[0];
    const humanCancelled = before.find((occurrence) => weekdayOf(occurrence.localDate) === kept);
    if (attended === undefined || humanCancelled === undefined) {
      throw new Error("fixture: the schedule named no dropped and kept weekday pair.");
    }
    expect(onDroppedDay).toHaveLength(4);

    const recorded = await app.handle(
      "POST",
      `/api/teams/${teamId}/occurrences/${attended.id}/attendance`,
      { headers: { ...sameOrigin, cookie }, body: { participantId, status: "yes" } },
    );
    expect(recorded.status).toBe(200);
    expect((await cancelOccurrence(cookie, teamId, humanCancelled.id, "Coach away")).status).toBe(
      200,
    );

    // The edit: one weekday leaves the schedule, so its future occurrences are
    // machine-cancelled.
    const afterDrop = await updateSeries(cookie, teamId, seriesId, {
      ...twoDays,
      schedule: weeklyOn([kept], start, until),
    });
    expect(afterDrop.status).toBe(200);
    for (const occurrence of createdOccurrences(afterDrop).filter(
      (candidate) => weekdayOf(candidate.localDate) === dropped,
    )) {
      expect(occurrence).toMatchObject({
        status: "cancelled",
        cancelledReason: RESCHEDULE_CANCEL_REASON,
      });
    }
    // Cancelled means attendance is closed — which is the damage the restore
    // has to undo, not merely a status string.
    const attend = (occurrenceId: string) =>
      app.handle("POST", `/api/teams/${teamId}/occurrences/${occurrenceId}/attendance`, {
        headers: { ...sameOrigin, cookie },
        body: { participantId, status: "yes" },
      });
    expect((await attend(attended.id)).status).toBe(409);

    // The undo: the same dates come back SCHEDULED on the same rows. Without
    // this the unique (series, local_date) index forecloses a replacement and
    // no shipped endpoint can un-cancel them.
    const afterRestore = await updateSeries(cookie, teamId, seriesId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(afterRestore.status).toBe(200);
    const after = createdOccurrences(afterRestore);
    expect(after.map((occurrence) => occurrence.id)).toEqual(
      before.map((occurrence) => occurrence.id),
    );
    for (const occurrence of after.filter(
      (candidate) => weekdayOf(candidate.localDate) === dropped,
    )) {
      expect(occurrence.status).toBe("scheduled");
      expect(occurrence.cancelledReason).toBeUndefined();
    }
    expect(
      await config.db
        .prepare("SELECT cancelled_at FROM event_occurrences WHERE id = ?")
        .get([attended.id]),
    ).toEqual({ cancelled_at: null });

    // A HUMAN cancellation on a kept date is not schedule state and survives.
    expect(after.find((occurrence) => occurrence.id === humanCancelled.id)).toMatchObject({
      status: "cancelled",
      cancelledReason: "Coach away",
    });
    // Attendance recorded before the drop is still attached after the restore,
    // and the occurrence takes new answers again.
    expect(
      await config.db.prepare("SELECT occurrence_id, status FROM event_attendance").all(),
    ).toEqual([{ occurrence_id: attended.id, status: "yes" }]);
    expect((await attend(attended.id)).status).toBe(200);
  });

  it("leaves a machine cancellation alone once its occurrence is in the past", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const start = isoDaysFromNow(-14);
    const until = isoDaysFromNow(14);
    const kept = weekdayOf(start);
    const twoDays = { title: "Two-day Practice", kind: "practice" };

    const created = await createSeries(cookie, teamId, seasonId, {
      ...twoDays,
      schedule: weeklyOn([kept], start, until),
    });
    expect(created.status).toBe(201);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const past = createdOccurrences(created).find((occurrence) => occurrence.localDate === start);
    if (past === undefined) throw new Error("fixture: the series has no occurrence on its start.");

    // What time itself would have produced: the edit that cancelled this date
    // ran while it was still ahead of us, and the date has since passed. The
    // cancellation is fabricated; the date being past is real.
    await config.db
      .prepare(
        "UPDATE event_occurrences SET status = 'cancelled', cancelled_reason = ?, cancelled_at = ? WHERE id = ?",
      )
      .run([RESCHEDULE_CANCEL_REASON, new Date().toISOString(), past.id]);

    const edited = await updateSeries(cookie, teamId, seriesId, {
      ...twoDays,
      title: "Renamed Practice",
      schedule: weeklyOn([kept], start, until),
    });
    expect(edited.status).toBe(200);
    expect(
      createdOccurrences(edited).find((occurrence) => occurrence.id === past.id),
    ).toMatchObject({ status: "cancelled", cancelledReason: RESCHEDULE_CANCEL_REASON });
  });

  it("reinstates on the instant the date is moving TO, not the stale stored one", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const start = isoDaysFromNow(7);
    const until = isoDaysFromNow(21);
    const kept = weekdayOf(start);
    const dropped = weekdayOf(isoDaysFromNow(8));
    const twoDays = { title: "Two-day Practice", kind: "practice" };

    const created = await createSeries(cookie, teamId, seasonId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(created.status).toBe(201);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const target = createdOccurrences(created).find(
      (occurrence) => weekdayOf(occurrence.localDate) === dropped,
    );
    if (target === undefined) throw new Error("fixture: the schedule named no dropped weekday.");

    expect(
      (
        await updateSeries(cookie, teamId, seriesId, {
          ...twoDays,
          schedule: weeklyOn([kept], start, until),
        })
      ).status,
    ).toBe(200);

    // A stored instant that disagrees with the local date is what a same-edit
    // `localTime` or zone change produces mid-reconcile. The kept-date branch
    // recomputes the instant regardless, so deciding reinstatement on the stale
    // value would strand a FUTURE occurrence cancelled under a reason that is
    // no longer true — the exact trap the reinstatement exists to close.
    await config.db
      .prepare("UPDATE event_occurrences SET starts_at_utc = ? WHERE id = ?")
      .run(["2020-01-01T00:00:00.000Z", target.id]);

    const afterRestore = await updateSeries(cookie, teamId, seriesId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(afterRestore.status).toBe(200);
    const restored = createdOccurrences(afterRestore).find(
      (occurrence) => occurrence.id === target.id,
    );
    expect(restored).toMatchObject({ status: "scheduled" });
    // The projection omits a null reason, so its ABSENCE is the cleared state.
    expect(restored).not.toHaveProperty("cancelledReason");
    expect(
      await config.db
        .prepare(
          "SELECT status, cancelled_reason, cancelled_at FROM event_occurrences WHERE id = ?",
        )
        .all([target.id]),
    ).toEqual([{ status: "scheduled", cancelled_reason: null, cancelled_at: null }]);
  });

  it("lets a human claim a machine-cancelled occurrence, which then survives a restore", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const start = isoDaysFromNow(7);
    const until = isoDaysFromNow(21);
    const kept = weekdayOf(start);
    const dropped = weekdayOf(isoDaysFromNow(8));
    const twoDays = { title: "Two-day Practice", kind: "practice" };

    const created = await createSeries(cookie, teamId, seasonId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(created.status).toBe(201);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const target = createdOccurrences(created).find(
      (occurrence) => weekdayOf(occurrence.localDate) === dropped,
    );
    if (target === undefined) throw new Error("fixture: the schedule named no dropped weekday.");

    expect(
      (
        await updateSeries(cookie, teamId, seriesId, {
          ...twoDays,
          schedule: weeklyOn([kept], start, until),
        })
      ).status,
    ).toBe(200);

    // The manager records the REAL reason over our marker. Treating that as an
    // idempotent no-op would report success while silently leaving the
    // cancellation reversible by the next edit.
    const claimed = await cancelOccurrence(cookie, teamId, target.id, "Field flooded");
    expect(claimed.status).toBe(200);
    expect(json(claimed)).toMatchObject({
      occurrence: { status: "cancelled", cancelledReason: "Field flooded" },
    });

    const afterRestore = await updateSeries(cookie, teamId, seriesId, {
      ...twoDays,
      schedule: weeklyOn([kept, dropped], start, until),
    });
    expect(afterRestore.status).toBe(200);
    expect(
      createdOccurrences(afterRestore).find((occurrence) => occurrence.id === target.id),
    ).toMatchObject({ status: "cancelled", cancelledReason: "Field flooded" });
  });

  it("hides edits from non-managers and unknown series", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const created = await createSeries(ownerCookie, teamId, seasonId);
    const seriesId = (json(created) as { series: { id: string } }).series.id;
    const memberCookie = await joinReadOnlyMember(ownerCookie, teamId);

    const asMember = await updateSeries(memberCookie, teamId, seriesId, weeklyPractice);
    expect(asMember.status).toBe(404);
    expect(json(asMember)).toEqual({ error: "team not found" });

    const unknown = await updateSeries(ownerCookie, teamId, "event_series_missing", weeklyPractice);
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toEqual({ error: "event not found" });
  });
});
