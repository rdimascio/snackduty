import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { statusForError } from "@lesto/web";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import {
  createCalendarFeed,
  createSeason,
  listInvitations,
  resendInvitation,
  revokeCalendarFeed,
  revokeInvitation,
  sendInvitation,
  setCoCoach,
} from "../app/team/team-actions";
import type { Fetcher } from "../app/team/team-actions";
import {
  loadCalendarFeedStatus,
  loadTeamInvitations,
  loadTeamMembers,
} from "../app/team/team-page-reads";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const OWNER_PERSON_ID = "person_dev_adult";
const SECOND_PERSON_ID = "person_dev_second_adult";
const sameOrigin = { "sec-fetch-site": "same-origin" };
const clock = () => Date.parse("2026-10-27T12:00:00.000Z");

let app: App;
let sql: Awaited<ReturnType<typeof openSqlite>>["db"];
let db: Awaited<ReturnType<typeof identityServices>>["db"];

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  sql = opened.db;
  const services = await identityServices(sql, { mode: "development", clock });
  db = services.db;
  const { config } = createApplication({
    sql,
    db,
    sessions: services.sessions,
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
    "DELETE FROM calendar_feed_tokens; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function bodyText(response: { body: unknown }): Promise<string> {
  const text =
    typeof response.body === "string"
      ? response.body
      : await new Response(response.body as ReadableStream).text();
  return text
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

function fetcherFor(cookie: string): Fetcher {
  return async (path, init) => {
    let response: Awaited<ReturnType<App["handle"]>>;
    try {
      response = await app.handle(init.method, path, {
        headers: { ...sameOrigin, cookie },
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      });
    } catch (error) {
      return { status: statusForError(error), json: async () => ({ error: "rejected" }) };
    }
    const text = await bodyText(response);
    return { status: response.status, json: async () => JSON.parse(text) as unknown };
  };
}

async function createTeam(cookie: string, name = "T-Ball Tigers"): Promise<string> {
  const response = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name },
  });
  expect(response.status).toBe(201);
  return (JSON.parse(await bodyText(response)) as { team: { id: string } }).team.id;
}

async function addSeason(cookie: string, teamId: string, label: string, startDate: string) {
  const result = await createSeason(fetcherFor(cookie), teamId, {
    label,
    startDate,
    endDate: "2027-12-01",
    timeZone: "America/Los_Angeles",
  });
  if (!result.ok) throw new Error(result.message);
  return result.value.seasonId;
}

async function seedMembership(teamId: string, role: "owner" | "coach" | "adult") {
  const now = new Date(clock()).toISOString();
  await sql
    .prepare(
      "INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    )
    .run([`adult_membership_${crypto.randomUUID()}`, teamId, SECOND_PERSON_ID, role, now, now]);
}

async function teamPage(cookie: string | undefined, query: Record<string, string> = {}) {
  const response = await app.handle("GET", "/app/team", {
    headers: cookie === undefined ? {} : { cookie },
    query,
  });
  return { status: response.status, html: await bodyText(response) };
}

interface Scenario {
  readonly owner: string;
  readonly second: string;
  readonly teamId: string;
  readonly seasonId: string;
}

async function scenario(secondRole?: "coach" | "adult"): Promise<Scenario> {
  const owner = await signIn();
  const second = await signIn("second-adult");
  const teamId = await createTeam(owner);
  const seasonId = await addSeason(owner, teamId, "Spring 2027", "2027-03-01");
  if (secondRole !== undefined) await seedMembership(teamId, secondRole);
  return { owner, second, teamId, seasonId };
}

const islandMarker = (name: string) => `"${name}"`;

describe("/app/team page", () => {
  it("shows a signed-out visitor the signed-out state and no team data", async () => {
    const { teamId } = await scenario("adult");
    const page = await teamPage(undefined, { team: teamId });
    expect(page.status).toBe(200);
    expect(page.html).toContain("Signed out");
    expect(page.html).not.toContain("T-Ball Tigers");
  });

  it("shows a signed-in adult with no team the empty state", async () => {
    const page = await teamPage(await signIn());
    expect(page.status).toBe(200);
    expect(page.html).toContain("No team yet");
  });

  it("renders the owner view with every coach control", async () => {
    const { owner, teamId } = await scenario("adult");
    const page = await teamPage(owner);
    expect(page.status).toBe(200);
    expect(page.html).toContain("T-Ball Tigers");
    expect(page.html).toContain("Spring 2027");
    expect(page.html).toContain("Your role");
    expect(page.html).toContain("Owner");
    expect(page.html).toContain("Adult member");
    expect(page.html).toContain(islandMarker("TeamSeasonForm"));
    expect(page.html).toContain(islandMarker("TeamMembers"));
    expect(page.html).toContain(islandMarker("TeamInvitations"));
    expect(page.html).toContain(islandMarker("TeamCalendarFeed"));
    expect(page.html).toContain(teamId);
  });

  it("gives a parent the team and members but no coach controls", async () => {
    const { second, teamId } = await scenario("adult");
    const page = await teamPage(second, { team: teamId });
    expect(page.status).toBe(200);
    expect(page.html).toContain("T-Ball Tigers");
    expect(page.html).toContain('aria-label="Adult members"');
    expect(page.html).toContain("(you)");
    expect(page.html).toContain("Only owners and co-coaches can change them.");
    expect(page.html).toContain(islandMarker("TeamCalendarFeed"));
    expect(page.html).not.toContain(islandMarker("TeamSeasonForm"));
    expect(page.html).not.toContain(islandMarker("TeamMembers"));
    expect(page.html).not.toContain(islandMarker("TeamInvitations"));
    expect(page.html).not.toContain("Create a season");
  });

  it("gives a co-coach the season form but not the owner-only controls", async () => {
    const { second, teamId } = await scenario("coach");
    const page = await teamPage(second, { team: teamId });
    expect(page.status).toBe(200);
    expect(page.html).toContain("Co-coach");
    expect(page.html).toContain(islandMarker("TeamSeasonForm"));
    expect(page.html).not.toContain(islandMarker("TeamMembers"));
    expect(page.html).not.toContain(islandMarker("TeamInvitations"));
  });

  it("answers a stranger's request for another team with a 404 that names nothing", async () => {
    const { second, teamId } = await scenario();
    const page = await teamPage(second, { team: teamId });
    expect(page.status).toBe(404);
    expect(page.html).toContain("Team not found");
    expect(page.html).not.toContain("T-Ball Tigers");
    expect(page.html).not.toContain("Spring 2027");
    expect(page.html).not.toContain(teamId);
  });

  it("never falls back to the stranger's own team when they ask for another", async () => {
    const { second, teamId } = await scenario();
    await createTeam(second, "Other Team");
    const page = await teamPage(second, { team: teamId });
    expect(page.status).toBe(404);
    expect(page.html).not.toContain("T-Ball Tigers");
    expect(page.html).not.toContain("Other Team");
  });

  it("keeps the invitations section off co-coach and parent pages", async () => {
    const { second, teamId } = await scenario("coach");
    const coachPage = await teamPage(second, { team: teamId });
    expect(coachPage.html).not.toContain('aria-labelledby="team-invitations"');
    await sql.exec("UPDATE adult_memberships SET role = 'adult';");
    const parentPage = await teamPage(second, { team: teamId });
    expect(parentPage.html).not.toContain('aria-labelledby="team-invitations"');
  });

  it("answers an unknown season with a 404", async () => {
    const { owner, teamId } = await scenario();
    const page = await teamPage(owner, { team: teamId, season: "season_missing" });
    expect(page.status).toBe(404);
  });

  it("switches seasons by link and marks the selected season", async () => {
    const { owner, teamId } = await scenario();
    const fallId = await addSeason(owner, teamId, "Fall 2027", "2027-09-01");
    const first = await teamPage(owner, { team: teamId });
    expect(first.html).toContain('aria-label="Switch season"');
    expect(first.html).toMatch(/aria-current="page"[^>]*>Spring 2027</u);
    const fall = await teamPage(owner, { team: teamId, season: fallId });
    expect(fall.status).toBe(200);
    expect(fall.html).toMatch(/aria-current="page"[^>]*>Fall 2027</u);
    expect(fall.html).toContain(`/app/team?team=${teamId}&season=${fallId}`);
  });

  it("lists the owner's pending invitations and keeps them from a parent", async () => {
    const { owner, second, teamId } = await scenario("adult");
    const sent = await sendInvitation(fetcherFor(owner), teamId, {
      inviteeLabel: "Jordan Lee",
      invitedRole: "adult",
      email: "jordan@example.com",
    });
    expect(sent.ok).toBe(true);
    const ownerPage = await teamPage(owner);
    expect(ownerPage.html).toContain("Jordan Lee");
    const parentPage = await teamPage(second, { team: teamId });
    expect(parentPage.html).not.toContain("Jordan Lee");
  });

  it("links every sidebar section and disables none", async () => {
    const { owner } = await scenario();
    const page = await teamPage(owner);
    for (const href of ["/app", "/app/team", "/app/roster", "/app/schedule", "/app/duties"]) {
      expect(page.html).toContain(`href="${href}"`);
    }
    expect(page.html).toContain(islandMarker("TeamNavigation"));
    expect(page.html).not.toContain('aria-disabled="true"');
    expect(page.html).not.toContain("coming soon");
  });
});

describe("Team page server reads", () => {
  it("lists members only for adults who can read the team", async () => {
    const { teamId } = await scenario("adult");
    const members = await loadTeamMembers(db, teamId, OWNER_PERSON_ID);
    expect(members?.map((member) => [member.personId, member.role])).toStrictEqual([
      [OWNER_PERSON_ID, "owner"],
      [SECOND_PERSON_ID, "adult"],
    ]);
    await sql.exec("DELETE FROM adult_memberships;");
    expect(await loadTeamMembers(db, teamId, SECOND_PERSON_ID)).toBeUndefined();
  });

  it("keeps invitations to owners", async () => {
    const { teamId } = await scenario("coach");
    expect(await loadTeamInvitations(db, teamId, OWNER_PERSON_ID, clock)).toStrictEqual([]);
    expect(await loadTeamInvitations(db, teamId, SECOND_PERSON_ID, clock)).toBeUndefined();
  });

  it("reports the calendar feed only to an adult who can read the team", async () => {
    const { teamId } = await scenario();
    expect(await loadCalendarFeedStatus(db, teamId, OWNER_PERSON_ID)).toStrictEqual({
      active: false,
    });
    expect(await loadCalendarFeedStatus(db, teamId, SECOND_PERSON_ID)).toBeUndefined();
  });
});

describe("Team page island actions against the real API", () => {
  it("creates a season for a coach and refuses a parent", async () => {
    const { second, teamId } = await scenario("coach");
    const created = await createSeason(fetcherFor(second), teamId, {
      label: "Summer 2027",
      startDate: "2027-06-01",
      endDate: "2027-08-01",
      timeZone: "America/Chicago",
    });
    expect(created.ok).toBe(true);
    await sql.exec("UPDATE adult_memberships SET role = 'adult';");
    const refused = await createSeason(fetcherFor(second), teamId, {
      label: "Winter 2027",
      startDate: "2027-12-01",
      endDate: "2027-12-20",
      timeZone: "America/Chicago",
    });
    expect(refused).toMatchObject({ ok: false, status: 404 });
  });

  it("explains an invalid season", async () => {
    const { owner, teamId } = await scenario();
    const result = await createSeason(fetcherFor(owner), teamId, {
      label: "Backwards",
      startDate: "2027-06-01",
      endDate: "2027-05-01",
      timeZone: "America/Chicago",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Check the season details");
  });

  it("grants and revokes co-coach as the owner", async () => {
    const { owner, teamId } = await scenario("adult");
    expect(await setCoCoach(fetcherFor(owner), teamId, SECOND_PERSON_ID, true)).toStrictEqual({
      ok: true,
      value: { role: "coach" },
    });
    const coachPage = await teamPage(owner);
    expect(coachPage.html).toContain("Co-coach");
    expect(await setCoCoach(fetcherFor(owner), teamId, SECOND_PERSON_ID, false)).toStrictEqual({
      ok: true,
      value: { role: "adult" },
    });
  });

  it("refuses co-coach changes from a co-coach and on the owner", async () => {
    const { owner, second, teamId } = await scenario("coach");
    const fromCoach = await setCoCoach(fetcherFor(second), teamId, SECOND_PERSON_ID, false);
    expect(fromCoach).toMatchObject({ ok: false, status: 404 });
    const onOwner = await setCoCoach(fetcherFor(owner), teamId, OWNER_PERSON_ID, true);
    expect(onOwner).toMatchObject({ ok: false, status: 409 });
  });

  it("sends, lists, resends, and revokes an invitation", async () => {
    const { owner, teamId } = await scenario();
    const fetcher = fetcherFor(owner);
    const sent = await sendInvitation(fetcher, teamId, {
      inviteeLabel: "Jordan Lee",
      invitedRole: "adult",
      email: "jordan@example.com",
    });
    if (!sent.ok) throw new Error(sent.message);
    expect(sent.value.status).toBe("pending");
    expect(sent.value.inviteUrl).toMatch(/^\/invite#/u);

    const duplicate = await sendInvitation(fetcher, teamId, {
      inviteeLabel: "Jordan Lee",
      invitedRole: "adult",
      email: "jordan@example.com",
    });
    expect(duplicate).toMatchObject({ ok: false, status: 409 });

    const listed = await listInvitations(fetcher, teamId);
    expect(listed.ok && listed.value.map((row) => row.inviteeLabel)).toStrictEqual(["Jordan Lee"]);

    const resent = await resendInvitation(fetcher, teamId, sent.value.id);
    if (!resent.ok) throw new Error(resent.message);
    expect(resent.value.inviteUrl).toMatch(/^\/invite#/u);
    expect(resent.value.inviteUrl).not.toBe(sent.value.inviteUrl);

    const revoked = await revokeInvitation(fetcher, teamId, sent.value.id);
    expect(revoked.ok && revoked.value.status).toBe("revoked");
    const page = await teamPage(owner);
    expect(page.html).toContain("No pending invitations.");
  });

  it("refuses invitation actions from a co-coach", async () => {
    const { owner, second, teamId } = await scenario("coach");
    const sent = await sendInvitation(fetcherFor(owner), teamId, {
      inviteeLabel: "Jordan Lee",
      invitedRole: "adult",
      email: "jordan@example.com",
    });
    if (!sent.ok) throw new Error(sent.message);
    const coach = fetcherFor(second);
    expect(
      await sendInvitation(coach, teamId, {
        inviteeLabel: "Sam Park",
        invitedRole: "adult",
        email: "sam@example.com",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await listInvitations(coach, teamId)).toMatchObject({ ok: false, status: 404 });
    expect(await resendInvitation(coach, teamId, sent.value.id)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await revokeInvitation(coach, teamId, sent.value.id)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("creates, rotates, and revokes a parent's calendar feed", async () => {
    const { second, teamId } = await scenario("adult");
    const fetcher = fetcherFor(second);
    const first = await createCalendarFeed(fetcher, teamId);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.path).toMatch(/^\/calendar\/feed\//u);
    expect((await app.handle("GET", first.value.path, {})).status).toBe(200);
    expect(await loadCalendarFeedStatus(db, teamId, SECOND_PERSON_ID)).toStrictEqual({
      active: true,
    });

    const rotated = await createCalendarFeed(fetcher, teamId);
    if (!rotated.ok) throw new Error(rotated.message);
    expect(rotated.value.path).not.toBe(first.value.path);
    expect((await app.handle("GET", first.value.path, {})).status).toBe(404);

    expect(await revokeCalendarFeed(fetcher, teamId)).toStrictEqual({
      ok: true,
      value: { revoked: true },
    });
    expect((await app.handle("GET", rotated.value.path, {})).status).toBe(404);
  });

  it("refuses a stranger's calendar feed", async () => {
    const { second, teamId } = await scenario();
    expect(await createCalendarFeed(fetcherFor(second), teamId)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("reports a network failure without throwing", async () => {
    const broken: Fetcher = () => Promise.reject(new Error("offline"));
    const result = await createCalendarFeed(broken, "team_x");
    expect(result).toMatchObject({ ok: false, status: 0 });
  });
});
