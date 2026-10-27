import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import type { AnyLestoResponse } from "@lesto/web";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedEventIdStem } from "../app/dev/seed-event-ids";
import { registerDevSkillEventRoutes } from "../app/dev/skill-events";
import { signInAs, signOut } from "../app/islands/ballplayer-session";
import { staticLessonCatalog } from "../app/lessons/catalog";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  SNACKDAY_CONTENT_SECURITY_POLICY,
} from "../app/server/content-security-policy";
import { ballplayerHome } from "../app/ballplayer/home-page";
import { routeBrands, secureBrands } from "../app/server/brand-routing";
import { playerIdFor } from "../app/skills/skill-events";
import { registerRuntimePages } from "../runtime/web-surface";
import { findThirdPartyRisks, hasInlineStyle } from "./support/third-party";

const NOW = Date.UTC(2026, 9, 26, 19);
const DAY_MS = 24 * 60 * 60 * 1_000;
const clock = () => NOW;
const BALLPLAYER_HOST = "ballplayer.localhost:3000";
const SNACKDAY_HOST = "localhost:3000";
const sameOrigin = { "sec-fetch-site": "same-origin" };

const { db: sql } = await openSqlite(":memory:");
const services = await identityServices(sql, { mode: "development", clock });
const { config } = createApplication({
  sql,
  db: services.db,
  sessions: services.sessions,
  mode: "development",
  clock,
  developmentSignIn: true,
  inviteDelivery: devInviteDeliverer(),
  invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
  lessons: { enabled: true, catalog: staticLessonCatalog([]) },
});
const routed = registerDevSkillEventRoutes(config.app, {
  enabled: true,
  db: services.db,
  sessions: services.sessions,
  clock,
});
const branded = routeBrands(routed, { home: ballplayerHome });
await registerRuntimePages(branded);
const app: App = await createApp({ ...config, app: secureBrands(branded) });

async function clearState() {
  await sql.exec(
    "DELETE FROM skill_events; DELETE FROM lesson_answers; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function header(response: AnyLestoResponse, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function json(response: AnyLestoResponse): Promise<unknown> {
  return JSON.parse(await textOf(response));
}

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: { ...sameOrigin, host: BALLPLAYER_HOST },
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function personIdOf(cookie: string): Promise<string> {
  const session = await app.handle("GET", "/api/session", { headers: { cookie } });
  return ((await json(session)) as { person: { id: string } }).person.id;
}

async function post(cookie: string, path: string, body?: unknown) {
  return app.handle("POST", path, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

async function seedTeam(cookie: string) {
  const team = await post(cookie, "/api/teams", { name: "Coach Pitch Comets" });
  expect(team.status).toBe(201);
  const teamId = ((await json(team)) as { team: { id: string } }).team.id;
  const season = await post(cookie, `/api/teams/${teamId}/seasons`, {
    label: "Fall 2026",
    startDate: "2026-09-01",
    endDate: "2026-12-01",
    timeZone: "America/Los_Angeles",
  });
  expect(season.status).toBe(201);
  const seasonId = ((await json(season)) as { season: { id: string } }).season.id;
  const participantIds: string[] = [];
  for (const displayName of ["Casey Kid", "Rowan Kid"]) {
    const child = await post(cookie, `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
      displayName,
      birthDate: "2020-04-09",
    });
    expect(child.status).toBe(201);
    participantIds.push(
      ((await json(child)) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  const [casey, rowan] = participantIds;
  if (casey === undefined || rowan === undefined) throw new Error("Seed data is missing.");
  return { teamId, casey, rowan };
}

async function joinTeam(
  ownerCookie: string,
  memberCookie: string,
  teamId: string,
  participantId?: string,
): Promise<void> {
  const created = await post(ownerCookie, `/api/teams/${teamId}/invitations`, {
    invitedRole: "adult",
    inviteeLabel: "joining adult",
    recipientBinding: { kind: "confirmed_person", personId: await personIdOf(memberCookie) },
    ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    ((await json(created)) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  const accepted = await post(memberCookie, "/api/invitations/accept", {
    token: inviteUrl.slice("/invite#".length),
  });
  expect(accepted.status).toBe(200);
}

function drill(participantId: string, index: number, daysAgo: number, skill: string) {
  const occurredAt = NOW - daysAgo * DAY_MS;
  return {
    contract: "skill.events/v0",
    id: `${seedEventIdStem(participantId)}seed${index}`,
    playerId: playerIdFor(participantId),
    occurredAt: new Date(occurredAt).toISOString(),
    localDate: new Date(occurredAt).toISOString().slice(0, 10),
    app: "snackday",
    type: "drill_completed",
    skill,
    source: { kind: "drill", id: `seed/${skill.replace(".", "-")}` },
  };
}

function week(participantId: string) {
  return [6, 5, 4, 3, 2, 1, 0].map((daysAgo, index) =>
    drill(
      participantId,
      index,
      daysAgo,
      index % 2 === 0 ? "infield.ready-position" : "baserunning.out-of-the-box",
    ),
  );
}

async function parentWithSeededCasey() {
  const ownerCookie = await signIn();
  const team = await seedTeam(ownerCookie);
  const parentCookie = await signIn("second-adult");
  await joinTeam(ownerCookie, parentCookie, team.teamId, team.casey);
  const seeded = await post(
    parentCookie,
    `/api/dev/teams/${team.teamId}/participants/${team.casey}/skill-events`,
    week(team.casey),
  );
  expect(seeded.status).toBe(200);
  return { ownerCookie, parentCookie, ...team };
}

async function ballplayerApp(cookie?: string): Promise<{ status: number; html: string }> {
  const response = await app.handle("GET", "/app", {
    headers: { host: BALLPLAYER_HOST, ...(cookie === undefined ? {} : { cookie }) },
  });
  expect(header(response, "content-security-policy")).toBe(BALLPLAYER_CONTENT_SECURITY_POLICY);
  expect(header(response, "cache-control")).toBe("private, no-store");
  return { status: response.status, html: await textOf(response) };
}

async function withSkillEventsUnreadable<T>(read: () => Promise<T>): Promise<T> {
  await sql.exec("ALTER TABLE skill_events RENAME TO skill_events_unreadable;");
  try {
    return await read();
  } finally {
    await sql.exec("ALTER TABLE skill_events_unreadable RENAME TO skill_events;");
  }
}

function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/giu)]
    .filter(([, , body]) => (body ?? "").trim() !== "")
    .map(([, attributes]) => attributes ?? "")
    .filter((attributes) => !attributes.includes('type="application/json"'));
}

function withoutIslandMounts(html: string): string {
  return html.replaceAll(
    /<script type="application\/json" data-lesto-island-mount="">[^<]*<\/script>/gu,
    "",
  );
}

function cardLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="Player card for ([^"]+)"/gu)].map(([, name]) => name ?? "");
}

describe("Ballplayer /app for each role", () => {
  it("asks a signed-out visitor to sign in and shows no child data", async () => {
    const { parentCookie } = await parentWithSeededCasey();
    expect(parentCookie).not.toBe("");

    const { status, html } = await ballplayerApp();

    expect(status).toBe(200);
    expect(html).toContain('data-brand="ballplayer"');
    expect(html).toContain("Development sign-in");
    expect(html).toContain("Sign in as Pat Parent (guardian)");
    expect(cardLabels(html)).toEqual([]);
    expect(html).not.toContain("Casey");
    expect(html).not.toContain("Rowan");
  });

  it("shows a parent only their own child, as their player, with the live streak", async () => {
    const { parentCookie } = await parentWithSeededCasey();

    const { status, html } = await ballplayerApp(parentCookie);

    expect(status).toBe(200);
    expect(cardLabels(html)).toEqual(["Casey Kid"]);
    expect(html).not.toContain("Rowan");
    expect(html).toContain("Coach Pitch Comets · Your player<");
    expect(html).not.toContain("Read only");
    expect(html).toContain("7-day streak");
    expect(html).toContain("1.5x");
    expect(html).not.toContain("Sample card");
    expect(html).toContain("Second Development Adult");
  });

  it("shows the owner every rostered child read-only", async () => {
    const { ownerCookie } = await parentWithSeededCasey();

    const { status, html } = await ballplayerApp(ownerCookie);

    expect(status).toBe(200);
    expect(cardLabels(html).toSorted()).toEqual(["Casey Kid", "Rowan Kid"]);
    expect(html).toContain("Coach Pitch Comets · Coach view · Read only");
    expect(html).not.toContain("· Your player<");
    expect(html).toContain("Cards for players you coach are read only.");
  });

  it("shows a co-coach the roster read-only only after the grant", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await seedTeam(ownerCookie);
    const coachCookie = await signIn("second-adult");
    await joinTeam(ownerCookie, coachCookie, teamId);

    const before = await ballplayerApp(coachCookie);
    expect(cardLabels(before.html)).toEqual([]);
    expect(before.html).toContain("No player cards yet");

    const granted = await post(
      ownerCookie,
      `/api/teams/${teamId}/adult-members/${await personIdOf(coachCookie)}/co-coach/grant`,
    );
    expect(granted.status).toBe(200);

    const after = await ballplayerApp(coachCookie);
    expect(cardLabels(after.html).toSorted()).toEqual(["Casey Kid", "Rowan Kid"]);
    expect(after.html).toContain("Coach view · Read only");
  });

  it("shows a stranger the empty state and no child data", async () => {
    await parentWithSeededCasey();
    await clearState();
    const ownerCookie = await signIn();
    await seedTeam(ownerCookie);
    const strangerCookie = await signIn("second-adult");

    const { status, html } = await ballplayerApp(strangerCookie);

    expect(status).toBe(200);
    expect(html).toContain("No player cards yet");
    expect(cardLabels(html)).toEqual([]);
    expect(html).not.toContain("Casey");
    expect(html).not.toContain("Rowan");
  });

  it("shows a guardian the error state, not the empty state, when the card read fails", async () => {
    const { parentCookie } = await parentWithSeededCasey();

    const { status, html } = await withSkillEventsUnreadable(() => ballplayerApp(parentCookie));

    expect(status).toBe(200);
    expect(html).toContain("Cards did not load");
    expect(html).not.toContain("No player cards yet");
    expect(cardLabels(html)).toEqual([]);
  });

  it("marks every /app state private and unstorable", async () => {
    const { parentCookie } = await parentWithSeededCasey();

    for (const response of await Promise.all([
      app.handle("GET", "/app", { headers: { host: BALLPLAYER_HOST } }),
      app.handle("GET", "/app", { headers: { host: BALLPLAYER_HOST, cookie: parentCookie } }),
      app.handle("HEAD", "/app", { headers: { host: BALLPLAYER_HOST, cookie: parentCookie } }),
    ])) {
      expect(header(response, "cache-control")).toBe("private, no-store");
    }
  });

  it("renders the signed-in page with no inline style or script and no other origin", async () => {
    const { parentCookie } = await parentWithSeededCasey();

    const { html } = await ballplayerApp(parentCookie);

    expect(hasInlineStyle(html)).toBe(false);
    expect(html).toContain('type="application/json" data-lesto-island-mount');
    expect(executableInlineScripts(html)).toEqual([]);
    expect(findThirdPartyRisks(withoutIslandMounts(html), "markup")).toEqual([]);
  });
});

describe("Ballplayer /app routing", () => {
  it("answers the internal page path with a 404 on every host", async () => {
    const cookie = await signIn();
    for (const host of [SNACKDAY_HOST, BALLPLAYER_HOST]) {
      const response = await app.handle("GET", "/__ballplayer/app", { headers: { host, cookie } });
      expect({ host, status: response.status }).toEqual({ host, status: 404 });
      expect(await textOf(response)).toBe("Not Found");
    }
  });

  it("keeps the Snackday /app on a Snackday host", async () => {
    const response = await app.handle("GET", "/app", { headers: { host: SNACKDAY_HOST } });
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(header(response, "content-security-policy")).toBe(SNACKDAY_CONTENT_SECURITY_POLICY);
    expect(html).not.toContain('data-brand="ballplayer"');
  });

  it("answers a write to /app on the Ballplayer host with a 404", async () => {
    const response = await app.handle("POST", "/app", {
      headers: { ...sameOrigin, host: BALLPLAYER_HOST },
    });
    expect(response.status).toBe(404);
  });

  it("links the Ballplayer landing page to sign-in", async () => {
    const response = await app.handle("GET", "/", { headers: { host: BALLPLAYER_HOST } });
    const html = await textOf(response);

    expect(html).toContain('href="/app"');
    expect(html).toContain("Sign in");
  });
});

function stubFetch(fake: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect });
}

const realFetch = globalThis.fetch;

describe("the Ballplayer session island actions", () => {
  let jar = "";

  beforeEach(() => {
    jar = "";
    stubFetch(async (url: string, init: RequestInit = {}) => {
      const response = await app.handle(init.method ?? "GET", url, {
        headers: { ...sameOrigin, host: BALLPLAYER_HOST, ...(jar === "" ? {} : { cookie: jar }) },
        ...(typeof init.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      const cookie = header(response, "set-cookie").split(";", 1)[0] ?? "";
      if (cookie !== "") jar = cookie.endsWith("=") ? "" : cookie;
      return new Response(await textOf(response), { status: response.status });
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("signs out through the session route and returns the page to signed out", async () => {
    jar = await signIn();
    const signedIn = jar;
    expect(signedIn).not.toBe("");

    expect(await signOut()).toEqual({ state: "working" });

    const { html } = await ballplayerApp(signedIn);
    expect(html).toContain("Development sign-in");
  });

  it("reports a refused persona as a failure", async () => {
    stubFetch(async () => new Response("", { status: 400 }));
    expect(await signInAs("parent")).toEqual({ state: "failed" });
  });

  it("reports a server without dev sign-in as unavailable", async () => {
    stubFetch(async () => new Response("", { status: 404 }));
    expect(await signInAs("parent")).toEqual({ state: "unavailable" });
  });
});
