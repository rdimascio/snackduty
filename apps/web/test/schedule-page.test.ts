import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import {
  buildEventInput,
  cancelOccurrence,
  createEvent,
  readAttendance,
  recordAttendance,
  updateSeries,
} from "../app/schedule/schedule-actions";
import type {
  ApiSender,
  CreateEventInput,
  EventFormValues,
} from "../app/schedule/schedule-actions";
import { csvCell } from "../app/schedule/schedule-export";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const MONDAY_2026_10_26_NOON_UTC = Date.UTC(2026, 9, 26, 12);
const TIME_ZONE = "America/Los_Angeles";
let now = MONDAY_2026_10_26_NOON_UTC;
const clock = () => now;

let app: App;
let sql: Awaited<ReturnType<typeof openSqlite>>["db"];

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  sql = opened.db;
  const { db, sessions } = await identityServices(sql, { mode: "development", clock });
  const { config } = createApplication({
    sql,
    db,
    sessions,
    mode: "development",
    clock,
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
    invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
  });
  await registerRuntimePages(config.app);
  app = await createApp(config);
});

async function clearState() {
  await sql.exec(
    "DELETE FROM event_creation_receipts; DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(async () => {
  now = MONDAY_2026_10_26_NOON_UTC;
  await clearState();
});
afterAll(clearState);

const sameOrigin = { "sec-fetch-site": "same-origin" };

function json(response: { body: unknown }): unknown {
  return JSON.parse(String(response.body));
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function bodyText(response: { body: unknown }): Promise<string> {
  if (typeof response.body === "string") return response.body;
  if (response.body instanceof Uint8Array) return new TextDecoder().decode(response.body);
  return new Response(response.body as ReadableStream).text();
}

async function pageText(response: { body: unknown }): Promise<string> {
  return (await bodyText(response))
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("<!-- -->", "");
}

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function personIdOf(cookie: string): Promise<string> {
  const session = await app.handle("GET", "/api/session", { headers: { cookie } });
  return (json(session) as { person: { id: string } }).person.id;
}

async function post(cookie: string, path: string, body?: unknown) {
  return app.handle("POST", path, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

function sender(cookie: string): ApiSender {
  return async (method, url, body) => {
    const response = await app.handle(method, url, {
      headers: { ...sameOrigin, cookie },
      ...(body === undefined ? {} : { body }),
    });
    const text = await bodyText(response);
    return {
      status: response.status,
      json: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  };
}

async function page(path: string, cookie?: string, query: Record<string, string> = {}) {
  const response = await app.handle("GET", path, {
    query,
    headers: cookie === undefined ? {} : { cookie },
  });
  return { status: response.status, response, html: await pageText(response) };
}

interface Team {
  readonly teamId: string;
  readonly seasonId: string;
  readonly caseyId: string;
  readonly rowanId: string;
}

async function seedTeam(ownerCookie: string, withSeason = true): Promise<Team> {
  const team = await post(ownerCookie, "/api/teams", { name: "T-Ball Tigers" });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;
  if (!withSeason) return { teamId, seasonId: "", caseyId: "", rowanId: "" };
  const season = await post(ownerCookie, `/api/teams/${teamId}/seasons`, {
    label: "Fall 2026",
    startDate: "2026-09-01",
    endDate: "2026-12-15",
    timeZone: TIME_ZONE,
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;
  const child = async (displayName: string) => {
    const created = await post(
      ownerCookie,
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        displayName,
        birthDate: "2019-04-09",
      },
    );
    expect(created.status).toBe(201);
    return (json(created) as { participant: { participantId: string } }).participant.participantId;
  };
  return { teamId, seasonId, caseyId: await child("Casey Kid"), rowanId: await child("Rowan Kid") };
}

async function joinAsSecondAdult(
  ownerCookie: string,
  teamId: string,
  participantId?: string,
): Promise<string> {
  const memberCookie = await signIn("second-adult");
  const created = await post(ownerCookie, `/api/teams/${teamId}/invitations`, {
    invitedRole: "adult",
    inviteeLabel: "joining adult",
    recipientBinding: { kind: "confirmed_person", personId: await personIdOf(memberCookie) },
    ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    (json(created) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  const accepted = await post(memberCookie, "/api/invitations/accept", {
    token: inviteUrl.slice("/invite#".length),
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

async function grantCoCoach(ownerCookie: string, teamId: string, memberCookie: string) {
  const personId = await personIdOf(memberCookie);
  const granted = await post(
    ownerCookie,
    `/api/teams/${teamId}/adult-members/${personId}/co-coach/grant`,
  );
  expect(granted.status).toBe(200);
}

function singleEvent(overrides: Partial<CreateEventInput> & { date: string }): CreateEventInput {
  const { date, ...rest } = overrides;
  return {
    title: "Practice at Lincoln",
    kind: "practice",
    location: "Lincoln Park Field 2",
    schedule: {
      timeZone: TIME_ZONE,
      localTime: "17:00",
      durationMinutes: 90,
      frequency: "once",
      startDate: date,
    },
    ...rest,
  };
}

async function created(cookie: string, team: Team, input: CreateEventInput): Promise<string> {
  const result = await createEvent(
    team.teamId,
    team.seasonId,
    input,
    crypto.randomUUID(),
    sender(cookie),
  );
  if (!result.ok) throw new Error(result.message);
  const occurrenceId = result.value.firstOccurrenceId;
  if (occurrenceId === undefined) throw new Error("The event created no occurrence.");
  return occurrenceId;
}

async function seedSchedule(ownerCookie: string, team: Team) {
  const past = await created(
    ownerCookie,
    team,
    singleEvent({ date: "2026-10-20", title: "Scrimmage vs Bears", kind: "game" }),
  );
  const upcoming = await created(
    ownerCookie,
    team,
    singleEvent({
      date: "2026-10-28",
      notes: "Bring a glove and water.",
      snackDuty: { label: "Snacks", instructions: "Orange slices for 12." },
    }),
  );
  return { past, upcoming };
}

const formValues: EventFormValues = {
  title: "Batting practice",
  kind: "practice",
  location: "",
  notes: "",
  date: "2026-10-27",
  startTime: "16:30",
  endTime: "18:00",
  repeat: "none",
  weekdays: [],
  untilDate: "",
  snackDuty: false,
  snackLabel: "Snacks",
  snackInstructions: "",
};

describe("/app/schedule role matrix", () => {
  it("shows the owner every coach control and the events grouped by day in the team time zone", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    await seedSchedule(owner, team);

    const { status, html } = await page("/app/schedule", owner);
    expect(status).toBe(200);
    expect(html).toContain("T-Ball Tigers");
    expect(html).toContain("Fall 2026 · Times in America/Los_Angeles");
    expect(html).toContain("Create event");
    expect(html).toContain("Export CSV");
    expect(html).toContain(`/app/schedule/export?team=${team.teamId}&season=${team.seasonId}`);
    expect(html).toContain("Wednesday, October 28");
    expect(html).toContain("5:00 PM – 6:30 PM");
    expect(html).toContain("Tuesday, October 20");
    expect(html.indexOf("Upcoming")).toBeLessThan(html.indexOf("Wednesday, October 28"));
    expect(html.indexOf("Wednesday, October 28")).toBeLessThan(html.indexOf(">Past<"));
    expect(html.indexOf(">Past<")).toBeLessThan(html.indexOf("Scrimmage vs Bears"));
    expect(html).toContain("0 going · 0 maybe · 0 not going");
    expect(html).toContain("claim it on Duties");
    expect(html).toContain(`/app/duties?team=${team.teamId}&season=${team.seasonId}`);
  });

  it("gives a co-coach the same coach controls the owner has", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const coach = await joinAsSecondAdult(owner, team.teamId);
    await grantCoCoach(owner, team.teamId, coach);

    const list = await page("/app/schedule", coach);
    expect(list.html).toContain("Create event");
    expect(list.html).toContain("Export CSV");

    const detail = await page(`/app/schedule/events/${upcoming}`, coach, { team: team.teamId });
    expect(detail.status).toBe(200);
    expect(detail.html).toContain("Edit series");
    expect(detail.html).toContain("Cancel this date");
    expect(detail.html).toContain("Take attendance");
    expect(detail.html).toContain("Attendance summary");
    expect(detail.html).toContain("Casey Kid");
    expect(detail.html).toContain("Rowan Kid");

    expect((await page("/app/schedule/new", coach)).status).toBe(200);
    const exported = await app.handle("GET", "/app/schedule/export", {
      headers: { cookie: coach },
    });
    expect(header(exported, "content-type")).toContain("text/csv");
  });

  it("shows a parent the schedule without coach controls and only their own child to answer for", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);

    const list = await page("/app/schedule", parent);
    expect(list.status).toBe(200);
    expect(list.html).toContain("Practice at Lincoln");
    expect(list.html).not.toContain("Create event");
    expect(list.html).not.toContain("Export CSV");

    const detail = await page(`/app/schedule/events/${upcoming}`, parent, { team: team.teamId });
    expect(detail.status).toBe(200);
    expect(detail.html).toContain("RSVP for your players");
    expect(detail.html).toContain("Casey Kid");
    expect(detail.html).not.toContain("Rowan Kid");
    expect(detail.html).not.toContain("Edit series");
    expect(detail.html).not.toContain("Cancel this date");
    expect(detail.html).not.toContain("Attendance summary");
    expect(detail.html).toContain("Bring a glove and water.");
  });

  it("refuses a parent the create, edit, and export pages with a 403", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    await seedSchedule(owner, team);
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);
    const seriesId = (
      (await sql.prepare("SELECT id FROM event_series LIMIT 1").get([])) as { id: string }
    ).id;

    const create = await page("/app/schedule/new", parent);
    expect(create.status).toBe(403);
    expect(create.html).toContain("Coaches only");
    expect(create.html).not.toContain('name="title"');

    const edit = await page(`/app/schedule/series/${seriesId}/edit`, parent, { team: team.teamId });
    expect(edit.status).toBe(403);
    expect(edit.html).toContain("Coaches only");

    const exported = await page("/app/schedule/export", parent, {
      team: team.teamId,
      season: team.seasonId,
    });
    expect(exported.status).toBe(403);
    expect(header(exported.response, "content-type")).not.toContain("text/csv");
    expect(exported.html).not.toContain("Practice at Lincoln");
  });

  it("answers a stranger 404 on every schedule page and leaks no event", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const seriesId = (
      (await sql.prepare("SELECT id FROM event_series LIMIT 1").get([])) as { id: string }
    ).id;
    const stranger = await signIn("second-adult");
    expect((await post(stranger, "/api/teams", { name: "Other Club" })).status).toBe(201);
    const query = { team: team.teamId, season: team.seasonId };
    const teamOnly = await page("/app/schedule", stranger, { team: team.teamId });
    expect(teamOnly.status).toBe(404);
    expect(teamOnly.html).toContain("Schedule not found");

    for (const path of [
      "/app/schedule",
      `/app/schedule/events/${upcoming}`,
      "/app/schedule/new",
      `/app/schedule/series/${seriesId}/edit`,
      "/app/schedule/export",
    ]) {
      const result = await page(path, stranger, query);
      expect(result.status, path).toBe(404);
      expect(result.html, path).toContain("Schedule not found");
      expect(result.html, path).not.toContain("Practice at Lincoln");
      expect(result.html, path).not.toContain("T-Ball Tigers");
      expect(header(result.response, "content-type"), path).not.toContain("text/csv");
    }
  });

  it("answers a signed-out visitor 401 and a missing event 404", async () => {
    const signedOut = await page("/app/schedule");
    expect(signedOut.status).toBe(401);
    expect(signedOut.html).toContain("Signed out");

    const owner = await signIn();
    const team = await seedTeam(owner);
    const missing = await page("/app/schedule/events/event_occurrence_missing", owner, {
      team: team.teamId,
    });
    expect(missing.status).toBe(404);
    expect(missing.html).toContain("Schedule not found");
    const wrongSeason = await page("/app/schedule", owner, {
      team: team.teamId,
      season: "season_missing",
    });
    expect(wrongSeason.status).toBe(404);
  });

  it("renders honest empty states for no team, no season, and no events", async () => {
    const owner = await signIn();
    expect((await page("/app/schedule", owner)).html).toContain("No team yet");

    await seedTeam(owner, false);
    expect((await page("/app/schedule", owner)).html).toContain("No season yet");

    await clearState();
    const fresh = await signIn();
    const team = await seedTeam(fresh);
    const coachView = await page("/app/schedule", fresh);
    expect(coachView.html).toContain("No events yet");
    expect(coachView.html).toContain("Create the first event");

    const parent = await joinAsSecondAdult(fresh, team.teamId, team.caseyId);
    const parentView = await page("/app/schedule", parent);
    expect(parentView.html).toContain("Events appear here after a coach adds them.");
    expect(parentView.html).not.toContain("Create the first event");
  });

  it("server-renders the create and edit forms for a coach", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    await created(owner, team, {
      ...singleEvent({ date: "2026-10-27" }),
      schedule: {
        timeZone: TIME_ZONE,
        localTime: "17:00",
        durationMinutes: 60,
        frequency: "weekly",
        byWeekday: ["tuesday", "thursday"],
        startDate: "2026-10-27",
        untilDate: "2026-11-12",
      },
    });
    const seriesId = (
      (await sql.prepare("SELECT id FROM event_series LIMIT 1").get([])) as { id: string }
    ).id;

    const create = await page("/app/schedule/new", owner);
    expect(create.html).toContain('aria-label="Create event"');
    expect(create.html).toContain('value="2026-10-27"');
    expect(create.html).toContain("Times are in the team time zone, America/Los_Angeles.");
    expect(create.html).toContain("Add a snack duty for families to claim");

    const edit = await page(`/app/schedule/series/${seriesId}/edit`, owner, { team: team.teamId });
    expect(edit.status).toBe(200);
    expect(edit.html).toContain('aria-label="Edit event series"');
    expect(edit.html).toContain('value="18:00"');
    expect(edit.html).toContain('value="2026-11-12"');
    expect(edit.html).toContain("Changes apply to every date in this series.");
    expect(edit.html).not.toContain("Add a snack duty");
  });
});

describe("schedule island actions against the real API", () => {
  it("creates a one-time event with snack duty that the list shows as open", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const built = buildEventInput(
      { ...formValues, snackDuty: true, snackInstructions: "Juice boxes" },
      TIME_ZONE,
      "create",
    );
    if (!built.ok) throw new Error("form should build");
    expect(built.input.schedule).toEqual({
      timeZone: TIME_ZONE,
      localTime: "16:30",
      durationMinutes: 90,
      frequency: "once",
      startDate: "2026-10-27",
    });
    const requestId = crypto.randomUUID();
    const first = await createEvent(
      team.teamId,
      team.seasonId,
      built.input,
      requestId,
      sender(owner),
    );
    const replay = await createEvent(
      team.teamId,
      team.seasonId,
      built.input,
      requestId,
      sender(owner),
    );
    expect(first.ok && replay.ok).toBe(true);
    expect(
      ((await sql.prepare("SELECT COUNT(*) AS n FROM event_series").get([])) as { n: number }).n,
    ).toBe(1);

    const html = (await page("/app/schedule", owner)).html;
    expect(html).toContain("Batting practice");
    expect(html).toContain("4:30 PM – 6:00 PM");
    expect(html).toContain("Snacks:");
    expect(html).toContain("claim it on Duties");
  });

  it("refuses a parent who tries to create, edit, or cancel", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);
    const seriesId = (
      (await sql
        .prepare("SELECT series_id AS id FROM event_occurrences WHERE id = ?")
        .get([upcoming])) as { id: string }
    ).id;

    const create = await createEvent(
      team.teamId,
      team.seasonId,
      singleEvent({ date: "2026-10-30" }),
      crypto.randomUUID(),
      sender(parent),
    );
    expect(create.ok).toBe(false);
    const update = await updateSeries(
      team.teamId,
      seriesId,
      singleEvent({ date: "2026-10-30" }),
      sender(parent),
    );
    expect(update.ok).toBe(false);
    const cancel = await cancelOccurrence(team.teamId, upcoming, "Rain", sender(parent));
    expect(cancel.ok).toBe(false);
    expect(
      ((await sql.prepare("SELECT COUNT(*) AS n FROM event_series").get([])) as { n: number }).n,
    ).toBe(2);
    expect((await page("/app/schedule", owner)).html).not.toContain("Cancelled");
  });

  it("edits a weekly series and cancels one occurrence with a reason the page shows", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const weekly = buildEventInput(
      {
        ...formValues,
        title: "Team practice",
        repeat: "weekly",
        weekdays: ["tuesday", "thursday"],
        untilDate: "2026-11-12",
      },
      TIME_ZONE,
      "create",
    );
    if (!weekly.ok) throw new Error("weekly form should build");
    expect(weekly.input.snackDuty).toBeUndefined();
    const firstId = await created(owner, team, weekly.input);
    const seriesId = (
      (await sql
        .prepare("SELECT series_id AS id FROM event_occurrences WHERE id = ?")
        .get([firstId])) as { id: string }
    ).id;

    const tuesdaysOnly = buildEventInput(
      {
        ...formValues,
        title: "Team practice",
        repeat: "weekly",
        weekdays: ["tuesday"],
        untilDate: "2026-11-12",
      },
      TIME_ZONE,
      "edit",
    );
    if (!tuesdaysOnly.ok) throw new Error("edit form should build");
    expect((await updateSeries(team.teamId, seriesId, tuesdaysOnly.input, sender(owner))).ok).toBe(
      true,
    );

    const reserved = await cancelOccurrence(
      team.teamId,
      firstId,
      "Removed by schedule change",
      sender(owner),
    );
    expect(reserved).toEqual({
      ok: false,
      message:
        "That cancellation reason is reserved for schedule changes. Describe this cancellation in your own words.",
    });
    expect(await cancelOccurrence(team.teamId, firstId, "  ", sender(owner))).toEqual({
      ok: false,
      message: "Tell families why this event is cancelled.",
    });
    expect((await cancelOccurrence(team.teamId, firstId, "Field flooded", sender(owner))).ok).toBe(
      true,
    );

    const html = (await page("/app/schedule", owner)).html;
    expect(html).toContain("Field flooded");
    expect(html).toContain("Removed by schedule change");
    expect(html).toContain("Cancelled");

    const detail = await page(`/app/schedule/events/${firstId}`, owner, { team: team.teamId });
    expect(detail.html).toContain("This date is cancelled.");
    expect(detail.html).toContain("Repeats weekly on Tuesday until November 12, 2026");
    expect(detail.html).not.toContain("Confirm cancellation");
  });

  it("records a parent's RSVP for their own child and refuses the other child", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);

    const before = await readAttendance(team.teamId, upcoming, sender(parent));
    if (!before.ok) throw new Error(before.message);
    expect(before.value.responseOptions.map((option) => option.displayName)).toEqual(["Casey Kid"]);

    const going = await recordAttendance(
      team.teamId,
      upcoming,
      team.caseyId,
      "yes",
      sender(parent),
    );
    if (!going.ok) throw new Error(going.message);
    expect(going.value.counts).toEqual({ yes: 1, maybe: 0, no: 0 });
    expect(going.value.responseOptions[0]?.status).toBe("yes");

    const other = await recordAttendance(team.teamId, upcoming, team.rowanId, "no", sender(parent));
    expect(other).toEqual({
      ok: false,
      message: "This event is no longer available to this account.",
    });

    const coachView = await page(`/app/schedule/events/${upcoming}`, owner, { team: team.teamId });
    expect(coachView.html).toContain("1 going · 0 maybe · 0 not going");
    expect(coachView.html).toMatch(/Going <span[^>]*>\(1\)<\/span><\/dt><dd[^>]*>Casey Kid/u);
    expect(coachView.html).toMatch(/No response <span[^>]*>\(1\)<\/span><\/dt><dd[^>]*>Rowan Kid/u);
    expect((await page("/app/schedule", parent)).html).toContain("1 going · 0 maybe · 0 not going");
  });

  it("refuses RSVP changes on a cancelled occurrence", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);
    expect((await cancelOccurrence(team.teamId, upcoming, "Rain", sender(owner))).ok).toBe(true);

    const refused = await recordAttendance(
      team.teamId,
      upcoming,
      team.caseyId,
      "yes",
      sender(parent),
    );
    expect(refused).toEqual({ ok: false, message: "This event can no longer accept changes." });
    const detail = await page(`/app/schedule/events/${upcoming}`, parent, { team: team.teamId });
    expect(detail.html).toContain("Cancelled events cannot accept RSVP changes.");
  });

  it("validates the form before it sends anything", () => {
    const bad = buildEventInput(
      {
        ...formValues,
        title: "  ",
        endTime: "16:00",
        repeat: "weekly",
        weekdays: [],
        untilDate: "2026-10-01",
      },
      TIME_ZONE,
      "create",
    );
    expect(bad).toEqual({
      ok: false,
      errors: {
        title: "Enter a title.",
        endTime: "End the event at least 5 minutes after it starts, on the same day.",
        weekdays: "Choose at least one day.",
        untilDate: "The last date cannot be before the first date.",
      },
    });
    const noSnackName = buildEventInput(
      { ...formValues, snackDuty: true, snackLabel: " " },
      TIME_ZONE,
      "create",
    );
    expect(noSnackName).toEqual({ ok: false, errors: { snackLabel: "Name the snack duty." } });
  });
});

describe("/app/schedule/export", () => {
  it("downloads the season schedule as CSV for the owner without child data", async () => {
    const owner = await signIn();
    const team = await seedTeam(owner);
    const { upcoming } = await seedSchedule(owner, team);
    await created(owner, team, singleEvent({ date: "2026-11-02", title: '=HYPERLINK("x")' }));
    const parent = await joinAsSecondAdult(owner, team.teamId, team.caseyId);
    await recordAttendance(team.teamId, upcoming, team.caseyId, "maybe", sender(parent));

    const response = await app.handle("GET", "/app/schedule/export", {
      query: { team: team.teamId, season: team.seasonId },
      headers: { cookie: owner },
    });
    expect(response.status).toBe(200);
    expect(header(response, "content-type")).toBe("text/csv; charset=utf-8");
    expect(header(response, "content-disposition")).toBe(
      'attachment; filename="snackday-schedule.csv"',
    );
    expect(header(response, "cache-control")).toBe("private, no-store");
    const lines = (await bodyText(response)).replace(/^﻿/u, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Date,Start,End,Time zone,Event,Type,Location,Status,Cancellation reason,Going,Maybe,Not going,Snack duty,Snack duty status",
    );
    expect(lines.slice(1)).toEqual([
      "2026-10-20,17:00,18:30,America/Los_Angeles,Scrimmage vs Bears,Game,Lincoln Park Field 2,Scheduled,,0,0,0,,",
      "2026-10-28,17:00,18:30,America/Los_Angeles,Practice at Lincoln,Practice,Lincoln Park Field 2,Scheduled,,0,1,0,Snacks,Open",
      `2026-11-02,17:00,18:30,America/Los_Angeles,"'=HYPERLINK(""x"")",Practice,Lincoln Park Field 2,Scheduled,,0,0,0,,`,
    ]);
    const csv = lines.join("\n");
    expect(csv).not.toContain("Casey");
    expect(csv).not.toContain("Rowan");
  });

  it("neutralizes spreadsheet formulas in every cell", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell(3)).toBe("3");
  });
});
