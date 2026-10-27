import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { statusForError } from "@lesto/web";
import { guardianRelationshipSchema } from "@snackday/domain";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { staticLessonCatalog } from "../app/lessons/catalog";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import {
  addParticipant,
  commitRosterImport,
  committableRows,
  GUARDIAN_RELATIONSHIPS,
  issueLabel,
  linkGuardian,
  previewRosterImport,
} from "../app/roster/roster-actions";
import type { RosterPoster } from "../app/roster/roster-actions";
import { AddParticipantForm, LinkGuardianForm, RosterImportForm } from "../app/roster/roster-forms";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const NOW = Date.UTC(2026, 9, 26, 19);
const clock = () => NOW;
const sameOrigin = { "sec-fetch-site": "same-origin" };

interface RosterTestApplication {
  readonly app: App;
  readonly sql: Awaited<ReturnType<typeof openSqlite>>["db"];
}

async function rosterTestApplication(lessonsEnabled: boolean): Promise<RosterTestApplication> {
  const { db: sql } = await openSqlite(":memory:");
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
    lessons: { enabled: lessonsEnabled, catalog: staticLessonCatalog([]) },
  });
  await registerRuntimePages(config.app);
  return { app: await createApp(config), sql };
}

let cardsOn: RosterTestApplication;
let cardsOff: RosterTestApplication;
let app: App;

beforeAll(async () => {
  cardsOn = await rosterTestApplication(true);
  cardsOff = await rosterTestApplication(false);
  app = cardsOn.app;
});

async function clearState(target: RosterTestApplication) {
  await target.sql.exec(
    "DELETE FROM skill_events; DELETE FROM lesson_answers; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(async () => {
  await clearState(cardsOn);
  await clearState(cardsOff);
});

afterAll(async () => {
  await clearState(cardsOn);
  await clearState(cardsOff);
});

function json(response: { body: unknown }): unknown {
  return JSON.parse(response.body as string);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function pageText(response: { body: unknown }): Promise<string> {
  const text =
    typeof response.body === "string"
      ? response.body
      : await new Response(response.body as ReadableStream).text();
  return text.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

async function signIn(target: App, persona?: "second-adult"): Promise<string> {
  const response = await target.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function personIdOf(target: App, cookie: string): Promise<string> {
  const session = await target.handle("GET", "/api/session", { headers: { cookie } });
  return (json(session) as { person: { id: string } }).person.id;
}

async function postAs(target: App, cookie: string, path: string, body?: unknown) {
  return target.handle("POST", path, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

function poster(target: App, cookie: string, calls: string[] = []): RosterPoster {
  return async (url, body) => {
    calls.push(url);
    try {
      const response = await postAs(target, cookie, url, body);
      const text = typeof response.body === "string" ? response.body : "";
      return {
        status: response.status,
        json: text === "" ? undefined : (JSON.parse(text) as unknown),
      };
    } catch (error) {
      return { status: statusForError(error), json: undefined };
    }
  };
}

interface SeedChild {
  readonly displayName: string;
  readonly birthDate?: string;
}

const defaultChildren: readonly SeedChild[] = [
  { displayName: "Casey Kid", birthDate: "2018-04-09" },
  { displayName: "Rowan Kid", birthDate: "2019-11-01" },
];

async function seedTeam(
  target: App,
  cookie: string,
  name = "Coach Pitch Comets",
  children: readonly SeedChild[] = defaultChildren,
  seasonLabel = "Fall 2026",
) {
  const team = await postAs(target, cookie, "/api/teams", { name });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;
  const season = await postAs(target, cookie, `/api/teams/${teamId}/seasons`, {
    label: seasonLabel,
    startDate: "2026-09-01",
    endDate: "2026-12-01",
    timeZone: "America/Los_Angeles",
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;
  const participantIds: string[] = [];
  for (const body of children) {
    const child = await postAs(
      target,
      cookie,
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      body,
    );
    expect(child.status).toBe(201);
    participantIds.push(
      (json(child) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  return { teamId, seasonId, participantIds };
}

async function seedComets(target: App, cookie: string) {
  const seeded = await seedTeam(target, cookie);
  const [casey, rowan] = seeded.participantIds;
  if (casey === undefined || rowan === undefined) throw new Error("Seed data is missing.");
  const guardian = await postAs(target, cookie, `/api/participants/${casey}/guardians`, {
    displayName: "Alex Guardian",
    relationship: "caregiver",
  });
  expect(guardian.status).toBe(201);
  return { ...seeded, casey, rowan };
}

async function joinAsSecondAdult(
  target: App,
  ownerCookie: string,
  teamId: string,
  participantId?: string,
): Promise<string> {
  const memberCookie = await signIn(target, "second-adult");
  const personId = await personIdOf(target, memberCookie);
  const created = await postAs(target, ownerCookie, `/api/teams/${teamId}/invitations`, {
    invitedRole: "adult",
    inviteeLabel: "joining adult",
    recipientBinding: { kind: "confirmed_person", personId },
    ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    (json(created) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  const accepted = await postAs(target, memberCookie, "/api/invitations/accept", {
    token: inviteUrl.slice("/invite#".length),
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

async function joinAsCoCoach(target: App, ownerCookie: string, teamId: string): Promise<string> {
  const coachCookie = await joinAsSecondAdult(target, ownerCookie, teamId);
  const personId = await personIdOf(target, coachCookie);
  const granted = await postAs(
    target,
    ownerCookie,
    `/api/teams/${teamId}/adult-members/${personId}/co-coach/grant`,
  );
  expect(granted.status).toBe(200);
  return coachCookie;
}

async function rosterPage(
  target: App,
  cookie: string | undefined,
  query: Record<string, string> = {},
) {
  const response = await target.handle("GET", "/app/roster", {
    headers: cookie === undefined ? {} : { cookie },
    query,
  });
  return { status: response.status, html: await pageText(response) };
}

async function cardPage(
  target: App,
  cookie: string,
  participantId: string,
  teamId?: string,
  seasonId?: string,
) {
  const response = await target.handle("GET", `/app/roster/${participantId}`, {
    headers: { cookie },
    query: {
      ...(teamId === undefined ? {} : { team: teamId }),
      ...(seasonId === undefined ? {} : { season: seasonId }),
    },
  });
  return { status: response.status, html: await pageText(response) };
}

function cardHref(teamId: string, participantId: string, seasonId?: string): string {
  const query = seasonId === undefined ? `team=${teamId}` : `team=${teamId}&season=${seasonId}`;
  return `/app/roster/${participantId}?${query}`;
}

function islandProps(html: string): string[] {
  return [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gu)].map(
    (match) => match[1] ?? "",
  );
}

function backToRosterHref(html: string): string | undefined {
  return /href="(\/app\/roster\?[^"]*)"[^>]*>← Back to the/u.exec(html)?.[1];
}

async function rosterNames(cookie: string, teamId: string, seasonId: string): Promise<string[]> {
  const response = await app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return (json(response) as { roster: { displayName: string }[] }).roster.map(
    (entry) => entry.displayName,
  );
}

describe("/app/roster page", () => {
  it("shows an owner every child with age, guardians, invitations, cards and coach tools", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, casey, rowan } = await seedComets(app, ownerCookie);
    const invited = await postAs(app, ownerCookie, `/api/teams/${teamId}/invitations`, {
      invitedRole: "adult",
      inviteeLabel: "Rowan's dad",
      recipientBinding: { kind: "verified_email", email: "rowan-dad@example.test" },
      participantId: rowan,
      relationship: "parent",
    });
    expect(invited.status).toBe(201);

    const { status, html } = await rosterPage(app, ownerCookie);
    expect(status).toBe(200);
    expect(html).toContain("Coach Pitch Comets");
    expect(html).toContain("Fall 2026 · coach view");
    expect(html).toContain("Casey Kid");
    expect(html).toContain(">Age 8</p>");
    expect(html).toContain("Rowan Kid");
    expect(html).toContain(">Age 6</p>");
    expect(html).not.toContain("Born");
    expect(html).not.toContain("2018-04-09");
    expect(html).not.toContain("2019-11-01");
    const props = islandProps(html);
    expect(props.some((block) => block.includes("Casey Kid"))).toBe(true);
    for (const block of props) {
      expect(block).not.toContain("2018-04-09");
      expect(block).not.toContain("2019-11-01");
      expect(block).not.toContain("birthDate");
    }
    expect(html).toContain("Alex Guardian");
    expect(html).toContain("(caregiver)");
    expect(html).toContain("Guardian invitations: 1 invited");
    expect(html).toContain("Guardian invitations: none sent");
    expect(html).not.toContain("dad");
    expect(html).not.toContain("rowan-dad@example.test");
    expect(html).toContain(`href="${cardHref(teamId, casey, seasonId)}"`);
    expect(html).toContain(`href="${cardHref(teamId, rowan, seasonId)}"`);
    expect(html).toContain('aria-label="Coach tools"');
    expect(html).toContain('aria-label="Add a player"');
    expect(html).toContain('aria-label="Import a roster"');
    expect(html).toContain('aria-label="Link a guardian to Casey Kid"');
  });

  it("shows a co-coach the whole roster and the coach tools", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, casey, rowan } = await seedComets(app, ownerCookie);
    const coachCookie = await joinAsCoCoach(app, ownerCookie, teamId);

    const { status, html } = await rosterPage(app, coachCookie);
    expect(status).toBe(200);
    expect(html).toContain("Casey Kid");
    expect(html).toContain("Rowan Kid");
    expect(html).toContain(">Age 8</p>");
    expect(html).not.toContain("2018-04-09");
    expect(html).toContain("Alex Guardian");
    expect(html).toContain('aria-label="Coach tools"');
    expect(html).toContain(`href="${cardHref(teamId, casey, seasonId)}"`);
    expect(html).toContain(`href="${cardHref(teamId, rowan, seasonId)}"`);
  });

  it("shows a parent only their own child and no coach controls", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, casey, rowan } = await seedComets(app, ownerCookie);
    const parentCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);

    const { status, html } = await rosterPage(app, parentCookie);
    expect(status).toBe(200);
    expect(html).toContain("Fall 2026 · your children");
    expect(html).toContain("Casey Kid");
    expect(html).toContain(">Age 8</p>");
    expect(html).not.toContain("Born");
    expect(html).not.toContain("2018-04-09");
    for (const block of islandProps(html)) expect(block).not.toContain("2018-04-09");
    expect(html).toContain("Second Development Adult");
    expect(html).toContain(`href="${cardHref(teamId, casey, seasonId)}"`);
    expect(html).not.toContain("Rowan Kid");
    expect(html).not.toContain(rowan);
    expect(html).not.toContain("2019-11-01");
    expect(html).not.toContain('aria-label="Coach tools"');
    expect(html).not.toContain("Add a player");
    expect(html).not.toContain("Import a roster");
    expect(html).not.toContain("Link a guardian");
  });

  it("tells an adult member with no child on the roster so, without listing other children", async () => {
    const ownerCookie = await signIn(app);
    const { teamId } = await seedComets(app, ownerCookie);
    const memberCookie = await joinAsSecondAdult(app, ownerCookie, teamId);

    const { status, html } = await rosterPage(app, memberCookie);
    expect(status).toBe(200);
    expect(html).toContain("No children of yours here");
    expect(html).not.toContain("Casey Kid");
    expect(html).not.toContain("Rowan Kid");
  });

  it("answers a stranger 404 for another team's roster and shows no child data", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedComets(app, ownerCookie);
    const strangerCookie = await signIn(app, "second-adult");

    for (const query of [{ team: teamId }, { team: teamId, season: seasonId }]) {
      expect((await rosterPage(app, ownerCookie, query)).status).toBe(200);
      const { status, html } = await rosterPage(app, strangerCookie, query);
      expect(status).toBe(404);
      expect(html).not.toContain("Casey Kid");
      expect(html).not.toContain("Coach Pitch Comets");
    }

    const own = await rosterPage(app, strangerCookie);
    expect(own.status).toBe(200);
    expect(own.html).toContain("No team yet");
    expect(own.html).not.toContain("Casey Kid");
  });

  it("answers 404 for a season that is not the selected team's", async () => {
    const ownerCookie = await signIn(app);
    const comets = await seedComets(app, ownerCookie);
    const meteors = await seedTeam(app, ownerCookie, "Majors Meteors", [
      { displayName: "Jordan Kid" },
    ]);

    const own = await rosterPage(app, ownerCookie, {
      team: comets.teamId,
      season: comets.seasonId,
    });
    expect(own.status).toBe(200);
    const crossed = await rosterPage(app, ownerCookie, {
      team: comets.teamId,
      season: meteors.seasonId,
    });
    expect(crossed.status).toBe(404);
    expect(crossed.html).not.toContain("Jordan Kid");
  });

  it("switches between the viewer's teams and seasons", async () => {
    const ownerCookie = await signIn(app);
    const comets = await seedComets(app, ownerCookie);
    const meteors = await seedTeam(app, ownerCookie, "Majors Meteors", [
      { displayName: "Jordan Kid" },
    ]);

    const first = await rosterPage(app, ownerCookie, { team: comets.teamId });
    expect(first.html).toContain('aria-label="Choose a team and season"');
    expect(first.html).toContain(
      `href="/app/roster?team=${meteors.teamId}&season=${meteors.seasonId}"`,
    );
    expect(first.html).toContain("Casey Kid");
    expect(first.html).not.toContain("Jordan Kid");

    const second = await rosterPage(app, ownerCookie, {
      team: meteors.teamId,
      season: meteors.seasonId,
    });
    expect(second.status).toBe(200);
    expect(second.html).toContain("Jordan Kid");
    expect(second.html).toContain("Age not on file");
    expect(second.html).not.toContain("Casey Kid");
    expect(second.html).toContain(
      `href="/app/roster?team=${comets.teamId}&season=${comets.seasonId}"`,
    );
  });

  it("renders honest signed-out, no-season and empty states", async () => {
    const signedOut = await rosterPage(app, undefined);
    expect(signedOut.status).toBe(200);
    expect(signedOut.html).toContain("Signed out");

    const forged = await rosterPage(app, "snackday_session_dev=forged-token");
    expect(forged.html).toContain("Signed out");

    const ownerCookie = await signIn(app);
    const team = await postAs(app, ownerCookie, "/api/teams", { name: "Seasonless Sharks" });
    expect(team.status).toBe(201);
    const noSeason = await rosterPage(app, ownerCookie);
    expect(noSeason.html).toContain("Seasonless Sharks");
    expect(noSeason.html).toContain("No season yet");
    expect(noSeason.html).not.toContain('aria-label="Coach tools"');

    const teamId = (json(team) as { team: { id: string } }).team.id;
    const season = await postAs(app, ownerCookie, `/api/teams/${teamId}/seasons`, {
      label: "Winter 2026",
      startDate: "2026-12-01",
      endDate: "2027-02-01",
      timeZone: "America/Los_Angeles",
    });
    expect(season.status).toBe(201);
    const empty = await rosterPage(app, ownerCookie);
    expect(empty.html).toContain("No players yet");
    expect(empty.html).toContain('aria-label="Coach tools"');
  });

  it("drops the player card links when player cards are off", async () => {
    const ownerCookie = await signIn(cardsOff.app);
    const { teamId, casey } = await seedComets(cardsOff.app, ownerCookie);

    const { html } = await rosterPage(cardsOff.app, ownerCookie);
    expect(html).toContain("Casey Kid");
    expect(html).not.toContain(`/app/roster/${casey}`);
    expect((await cardPage(cardsOff.app, ownerCookie, casey, teamId)).status).toBe(404);
  });

  it("keeps identity and credential material out of the page", async () => {
    const ownerCookie = await signIn(app);
    await seedComets(app, ownerCookie);
    const { html } = await rosterPage(app, ownerCookie);
    const lowered = html.toLowerCase();
    for (const forbidden of ["@example", "person_", "account_", "token", "createdbypersonid"]) {
      expect(lowered).not.toContain(forbidden);
    }
  });
});

describe("/app/roster/:participantId player card", () => {
  it("shows the owner and a co-coach a rostered child's card read-only", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedComets(app, ownerCookie);

    const owner = await cardPage(app, ownerCookie, casey, teamId);
    expect(owner.status).toBe(200);
    expect(owner.html).toContain("Casey Kid");
    expect(owner.html).toContain('<span class="text-muted-foreground">Overall </span>');
    expect(owner.html).toContain(`href="/app/roster?team=${teamId}"`);
    expect(owner.html).not.toContain("<button");

    const coachCookie = await joinAsCoCoach(app, ownerCookie, teamId);
    const coach = await cardPage(app, coachCookie, casey, teamId);
    expect(coach.status).toBe(200);
    expect(coach.html).toContain("Casey Kid");
  });

  it("shows a parent their own child's card and 404s every other child", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, casey, rowan } = await seedComets(app, ownerCookie);
    const parentCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);

    const own = await cardPage(app, parentCookie, casey, teamId);
    expect(own.status).toBe(200);
    expect(own.html).toContain("Casey Kid");

    const other = await cardPage(app, parentCookie, rowan, teamId);
    expect(other.status).toBe(404);
    expect(other.html).not.toContain("Rowan Kid");
  });

  it("answers a stranger and a request without a team 404", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedComets(app, ownerCookie);
    const strangerCookie = await signIn(app, "second-adult");

    const stranger = await cardPage(app, strangerCookie, casey, teamId);
    expect(stranger.status).toBe(404);
    expect(stranger.html).not.toContain("Casey Kid");

    expect((await cardPage(app, ownerCookie, casey)).status).toBe(404);
  });

  it("returns to the season the card was opened from", async () => {
    const ownerCookie = await signIn(app);
    const fall = await seedTeam(app, ownerCookie, "Coach Pitch Comets", [
      { displayName: "Fallon Kid", birthDate: "2018-04-09" },
    ]);
    const [fallon] = fall.participantIds;
    if (fallon === undefined) throw new Error("Seed data is missing.");
    const spring = await postAs(app, ownerCookie, `/api/teams/${fall.teamId}/seasons`, {
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
    });
    expect(spring.status).toBe(201);
    const meteors = await seedTeam(app, ownerCookie, "Majors Meteors", [
      { displayName: "Jordan Kid" },
    ]);

    const opened = await rosterPage(app, ownerCookie, { team: fall.teamId });
    expect(opened.html).toContain("Spring 2026 · coach view");
    expect(opened.html).not.toContain("Fallon Kid");

    const fallRoster = await rosterPage(app, ownerCookie, {
      team: fall.teamId,
      season: fall.seasonId,
    });
    expect(fallRoster.html).toContain(`href="${cardHref(fall.teamId, fallon, fall.seasonId)}"`);

    const card = await cardPage(app, ownerCookie, fallon, fall.teamId, fall.seasonId);
    expect(card.status).toBe(200);
    const back = backToRosterHref(card.html);
    expect(back).toBe(`/app/roster?team=${fall.teamId}&season=${fall.seasonId}`);

    const returned = await rosterPage(
      app,
      ownerCookie,
      Object.fromEntries(new URL(back ?? "", "http://snackday.test").searchParams),
    );
    expect(returned.status).toBe(200);
    expect(returned.html).toContain("Fall 2026 · coach view");
    expect(returned.html).toContain("Fallon Kid");

    const crossed = await cardPage(app, ownerCookie, fallon, fall.teamId, meteors.seasonId);
    expect(crossed.status).toBe(200);
    expect(backToRosterHref(crossed.html)).toBe(`/app/roster?team=${fall.teamId}`);
  });
});

describe("roster actions against the real API", () => {
  it("lets a coach add a player and refuses a parent", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, casey } = await seedComets(app, ownerCookie);

    const added = await addParticipant(
      teamId,
      seasonId,
      { displayName: "  Morgan Kid ", birthDate: "2019-02-03" },
      poster(app, ownerCookie),
    );
    expect(added).toEqual({ ok: true, message: "Added Morgan Kid." });
    expect(await rosterNames(ownerCookie, teamId, seasonId)).toContain("Morgan Kid");

    const invalid = await addParticipant(
      teamId,
      seasonId,
      { displayName: "Bad Date", birthDate: "03/02/2019" },
      poster(app, ownerCookie),
    );
    expect(invalid.ok).toBe(false);
    expect(await rosterNames(ownerCookie, teamId, seasonId)).not.toContain("Bad Date");

    const calls: string[] = [];
    expect(
      await addParticipant(teamId, seasonId, { displayName: " " }, poster(app, ownerCookie, calls)),
    ).toEqual({
      ok: false,
      message: "Enter the player's name.",
    });
    expect(calls).toEqual([]);

    const parentCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const refused = await addParticipant(
      teamId,
      seasonId,
      { displayName: "Sneaky Kid" },
      poster(app, parentCookie),
    );
    expect(refused).toEqual({
      ok: false,
      message: "You can't change this roster. Ask a team coach.",
    });
    expect(await rosterNames(ownerCookie, teamId, seasonId)).not.toContain("Sneaky Kid");
  });

  it("lets a co-coach link a guardian, reports a duplicate, and refuses a parent", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, rowan, casey } = await seedComets(app, ownerCookie);
    const coachCookie = await joinAsCoCoach(app, ownerCookie, teamId);

    const linked = await linkGuardian(
      rowan,
      { displayName: "Jamie Guardian", relationship: "parent" },
      poster(app, coachCookie),
    );
    expect(linked).toEqual({ ok: true, message: "Linked Jamie Guardian." });
    const page = await rosterPage(app, ownerCookie);
    expect(page.html).toContain("Jamie Guardian");

    const duplicate = await linkGuardian(
      rowan,
      { displayName: "jamie guardian", relationship: "parent" },
      poster(app, coachCookie),
    );
    expect(duplicate).toEqual({
      ok: false,
      message: "That guardian is already linked to this child.",
    });

    await clearState(cardsOn);
    const freshOwner = await signIn(app);
    const fresh = await seedComets(app, freshOwner);
    const parentCookie = await joinAsSecondAdult(app, freshOwner, fresh.teamId, fresh.casey);
    const refused = await linkGuardian(
      fresh.rowan,
      { displayName: "Not Allowed", relationship: "other" },
      poster(app, parentCookie),
    );
    expect(refused).toEqual({
      ok: false,
      message: "You can't change this roster. Ask a team coach.",
    });
    expect((await rosterPage(app, freshOwner)).html).not.toContain("Not Allowed");
    expect(casey).not.toBe(fresh.casey);
  });

  it("previews a CSV with row errors, then imports only the ready rows once", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedComets(app, ownerCookie);
    const csv = [
      "child_name,birth_date,guardian1_name,guardian1_relationship",
      "Taylor Kid,2019-05-14,Pat Guardian,parent",
      "Casey Kid,2018-04-09,,",
      "Taylor Kid,2019-05-14,,",
      ",2019-01-01,,",
      "Quinn Kid,May 2019,,",
      "Avery Kid,,,uncle",
      "Blake Kid,,Sam Guardian,",
    ].join("\n");

    const preview = await previewRosterImport(teamId, seasonId, csv, poster(app, ownerCookie));
    if (preview.kind !== "preview") throw new Error("The preview must succeed.");
    expect(preview.preview.summary).toEqual({
      rows: 7,
      valid: 2,
      duplicateInFile: 1,
      duplicateInRoster: 1,
      invalid: 3,
    });
    const verdicts = preview.preview.rows.map((row) => [row.line, row.verdict]);
    expect(verdicts).toEqual([
      [2, "valid"],
      [3, "duplicate_in_roster"],
      [4, "duplicate_in_file"],
      [5, "invalid"],
      [6, "invalid"],
      [7, "invalid"],
      [8, "valid"],
    ]);
    const labels = preview.preview.rows.flatMap((row) => (row.issues ?? []).map(issueLabel));
    expect(labels).toEqual([
      "The child's name is missing.",
      "The birth date must be YYYY-MM-DD.",
      "Guardian 1 has a relationship but no name.",
    ]);
    expect(await rosterNames(ownerCookie, teamId, seasonId)).not.toContain("Taylor Kid");

    const rows = committableRows(preview.preview);
    expect(rows.map((row) => row.displayName)).toEqual(["Taylor Kid", "Blake Kid"]);
    const committed = await commitRosterImport(teamId, seasonId, rows, poster(app, ownerCookie));
    expect(committed).toEqual({ ok: true, message: "Imported 2 players." });
    const names = await rosterNames(ownerCookie, teamId, seasonId);
    expect(names.filter((name) => name === "Taylor Kid")).toHaveLength(1);
    expect(names).toContain("Blake Kid");
    expect((await rosterPage(app, ownerCookie)).html).toContain("Pat Guardian");

    const replay = await commitRosterImport(teamId, seasonId, rows, poster(app, ownerCookie));
    expect(replay).toEqual({
      ok: true,
      message: "Imported 0 players. Skipped 2 already on the roster.",
    });
    expect((await rosterNames(ownerCookie, teamId, seasonId)).length).toBe(names.length);
  });

  it("shows a file-level refusal without echoing the file", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedComets(app, ownerCookie);

    const refused = await previewRosterImport(
      teamId,
      seasonId,
      "child_name,email\nTaylor Kid,taylor@example.test",
      poster(app, ownerCookie),
    );
    if (refused.kind !== "rejected") throw new Error("The preview must refuse the file.");
    expect(refused.rejection.code).toBe("child_email_column");
    expect(refused.rejection.column).toBe(2);
    expect(JSON.stringify(refused)).not.toContain("taylor");

    const blank = await previewRosterImport(teamId, seasonId, "  ", poster(app, ownerCookie));
    expect(blank.kind).toBe("failed");
  });

  it("refuses a parent both the import preview and the commit", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, casey } = await seedComets(app, ownerCookie);
    const parentCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);

    const preview = await previewRosterImport(
      teamId,
      seasonId,
      "child_name\nTaylor Kid",
      poster(app, parentCookie),
    );
    expect(preview).toEqual({
      kind: "failed",
      message: "You can't change this roster. Ask a team coach.",
    });
    const commit = await commitRosterImport(
      teamId,
      seasonId,
      [{ displayName: "Taylor Kid", guardians: [] }],
      poster(app, parentCookie),
    );
    expect(commit.ok).toBe(false);
    expect(await rosterNames(ownerCookie, teamId, seasonId)).not.toContain("Taylor Kid");
  });

  it("offers exactly the relationships the domain accepts", () => {
    expect([...GUARDIAN_RELATIONSHIPS].sort()).toEqual(
      [...guardianRelationshipSchema.shape.relationship.options].sort(),
    );
  });
});

describe("roster islands mounted against the real API", () => {
  let createRoot: typeof import("react-dom/client").createRoot;
  let window: import("happy-dom").Window;
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const roots: Root[] = [];

  beforeAll(async () => {
    const { Window } = await import("happy-dom");
    window = new Window({ url: "https://snackday.test/" });
    const globals = {
      window,
      document: window.document,
      FormData: window.FormData,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    ({ createRoot } = await import("react-dom/client"));
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(() => root.unmount());
    window.document.body.innerHTML = "";
  });

  afterAll(async () => {
    await window.happyDOM.close();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });

  async function mount(element: ReturnType<typeof createElement>) {
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container as unknown as HTMLElement);
    roots.push(root);
    await act(() => root.render(element));
    return container;
  }

  async function settle(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }

  function setValue(element: unknown, value: string) {
    const field = element as { value: string; dispatchEvent(event: unknown): boolean };
    const prototype = Object.getPrototypeOf(field) as object;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) throw new Error("The field has no value setter.");
    setter.call(field, value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  }

  async function submit(form: unknown) {
    if (form === null || form === undefined) throw new Error("The form is missing.");
    await act(async () => {
      (form as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }

  it("adds a player from the form and reports the change", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedComets(app, ownerCookie);
    let changed = 0;
    const container = await mount(
      createElement(AddParticipantForm, {
        teamId,
        seasonId,
        post: poster(app, ownerCookie),
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    await act(async () => {
      setValue(container.querySelector('input[name="displayName"]'), "Morgan Kid");
      setValue(container.querySelector('input[name="birthDate"]'), "2019-02-03");
    });
    await submit(container.querySelector("form"));
    await settle(() => changed > 0);

    expect(changed).toBe(1);
    expect(container.textContent).toContain("Added Morgan Kid.");
    expect(await rosterNames(ownerCookie, teamId, seasonId)).toContain("Morgan Kid");
  });

  it("shows a parent the refusal and changes nothing", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedComets(app, ownerCookie);
    const parentCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    let changed = 0;
    const container = await mount(
      createElement(LinkGuardianForm, {
        participantId: casey,
        childName: "Casey Kid",
        post: poster(app, parentCookie),
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    await act(async () => {
      setValue(container.querySelector('input[name="guardianName"]'), "Uninvited Adult");
    });
    await submit(container.querySelector("form"));
    await settle(() => container.querySelector('[role="alert"]') !== null);

    expect(changed).toBe(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "You can't change this roster. Ask a team coach.",
    );
    expect((await rosterPage(app, ownerCookie)).html).not.toContain("Uninvited Adult");
  });

  it("previews a pasted CSV, shows row errors, then imports on confirm", async () => {
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedComets(app, ownerCookie);
    let changed = 0;
    const calls: string[] = [];
    const container = await mount(
      createElement(RosterImportForm, {
        teamId,
        seasonId,
        post: poster(app, ownerCookie, calls),
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    await act(async () => {
      setValue(
        container.querySelector("textarea"),
        "child_name,birth_date\nTaylor Kid,2019-05-14\nQuinn Kid,May 2019",
      );
    });
    await submit(container.querySelector("form"));
    await settle(() => container.querySelector('table[aria-label="Import preview"]') !== null);

    const table = container.querySelector('table[aria-label="Import preview"]');
    expect(table?.textContent).toContain("Taylor Kid");
    expect(table?.textContent).toContain("Ready");
    expect(table?.textContent).toContain("Needs a fix");
    expect(table?.textContent).toContain("The birth date must be YYYY-MM-DD.");
    expect(table?.textContent).not.toContain("Quinn Kid");
    expect(await rosterNames(ownerCookie, teamId, seasonId)).not.toContain("Taylor Kid");

    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Import 1 player",
    );
    if (confirm === undefined) throw new Error("The confirm button is missing.");
    await act(async () => {
      confirm.click();
    });
    await settle(() => changed > 0);

    expect(changed).toBe(1);
    expect(container.textContent).toContain("Imported 1 player.");
    expect(calls).toEqual([
      `/api/teams/${teamId}/seasons/${seasonId}/roster/import/preview`,
      `/api/teams/${teamId}/seasons/${seasonId}/roster/import`,
    ]);
    const names = await rosterNames(ownerCookie, teamId, seasonId);
    expect(names).toContain("Taylor Kid");
    expect(names).not.toContain("Quinn Kid");
  });
});
