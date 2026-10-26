import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { PILOT_AGE_BAND, selectLessonOfTheWeek } from "@snackday/domain";
import type { Lesson } from "@snackday/domain";
import { parseSkillEvents, rate, rulesV0, taxonomyV0 } from "@snackday/skill-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { staticLessonCatalog } from "../app/lessons/catalog";
import type { CatalogEpisode } from "../app/lessons/catalog";
import { parseReelEpisode } from "../app/lessons/reel-contract";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { reelSkillMap, taxonomySkillForReelSkill } from "../app/skills/reel-skill-map";
import { appendCheckPassed, playerIdFor, wholeYearsBetween } from "../app/skills/skill-events";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const contractDirectory = join(import.meta.dirname, "../../../contracts/reel-episode-v0");

interface VendoredManifest {
  readonly quiz: { id: string; skill?: string }[];
}

function readManifest(name: string): VendoredManifest {
  return JSON.parse(readFileSync(join(contractDirectory, name), "utf8")) as VendoredManifest;
}

function episodeFrom(manifest: VendoredManifest): CatalogEpisode {
  const result = parseReelEpisode(manifest);
  if (!result.ok) throw new Error("Manifest must parse.");
  return { lesson: result.value, quizSkills: result.quizSkills };
}

function vendoredEpisode(name: string): CatalogEpisode {
  return episodeFrom(readManifest(name));
}

const runToFirst = vendoredEpisode("run-to-first.v1.episode.json");
const strikeOut = vendoredEpisode("its-ok-to-strike-out.v1.episode.json");
const TRAILING_HYPHEN_QUIZ_ID = "where-to-run-";
const runToFirstTrailingHyphen = episodeFrom(
  (() => {
    const manifest = readManifest("run-to-first.v1.episode.json");
    const [first, ...rest] = manifest.quiz;
    if (first === undefined) throw new Error("Vendored manifest has no quiz.");
    return {
      ...manifest,
      quiz: [{ ...first, id: TRAILING_HYPHEN_QUIZ_ID }, ...rest],
    };
  })(),
);
const vendoredLessons = [runToFirst.lesson, strikeOut.lesson];

const MONDAY_2026_10_26_NOON_UTC = Date.UTC(2026, 9, 26, 12);
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const TEAM_TIME_ZONE = "America/Los_Angeles";
const CASEY_BIRTH_DATE = "2020-04-09";

let now = MONDAY_2026_10_26_NOON_UTC;
const clock = () => now;

interface SkillTestApplication {
  readonly app: App;
  readonly sql: Awaited<ReturnType<typeof openSqlite>>["db"];
  readonly db: Awaited<ReturnType<typeof identityServices>>["db"];
}

async function skillTestApplication(
  enabled: boolean,
  episodes: readonly CatalogEpisode[] = [runToFirst, strikeOut],
): Promise<SkillTestApplication> {
  const { db: sql } = await openSqlite(":memory:");
  const { db, sessions } = await identityServices(sql, {
    mode: "development",
    clock,
  });
  const { config } = createApplication({
    sql,
    db,
    sessions,
    mode: "development",
    clock,
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
    invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
    lessons: { enabled, catalog: staticLessonCatalog(episodes) },
  });
  await registerRuntimePages(config.app);
  return { app: await createApp(config), sql, db };
}

let flagOn: SkillTestApplication;
let flagOff: SkillTestApplication;
let trailingHyphen: SkillTestApplication;

beforeAll(async () => {
  flagOn = await skillTestApplication(true);
  flagOff = await skillTestApplication(false);
  trailingHyphen = await skillTestApplication(true, [runToFirstTrailingHyphen, strikeOut]);
});

async function clearState(target: SkillTestApplication) {
  await target.sql.exec(
    "DELETE FROM skill_events; DELETE FROM lesson_answers; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(async () => {
  now = MONDAY_2026_10_26_NOON_UTC;
  await clearState(flagOn);
  await clearState(flagOff);
  await clearState(trailingHyphen);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await clearState(flagOn);
  await clearState(flagOff);
  await clearState(trailingHyphen);
});

const sameOrigin = { "sec-fetch-site": "same-origin" };

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

async function pageText(response: { body: unknown }): Promise<string> {
  const text =
    typeof response.body === "string"
      ? response.body
      : await new Response(response.body as ReadableStream).text();
  return text.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function signIn(app: App, persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function personIdOf(app: App, cookie: string): Promise<string> {
  const session = await app.handle("GET", "/api/session", {
    headers: { cookie },
  });
  return (json(session) as { person: { id: string } }).person.id;
}

async function seedTeam(app: App, cookie: string) {
  const team = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Coach Pitch Comets" },
  });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;
  const season = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Fall 2026",
      startDate: "2026-09-01",
      endDate: "2026-12-01",
      timeZone: TEAM_TIME_ZONE,
    },
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;
  const participantIds: string[] = [];
  for (const [displayName, birthDate] of [
    ["Casey Kid", CASEY_BIRTH_DATE],
    ["Rowan Kid", "2020-06-14"],
  ] as const) {
    const child = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      { headers: { ...sameOrigin, cookie }, body: { displayName, birthDate } },
    );
    expect(child.status).toBe(201);
    participantIds.push(
      (json(child) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  const [casey] = participantIds;
  if (casey === undefined) throw new Error("Seed data is missing.");
  return { teamId, seasonId, casey };
}

async function joinAsSecondAdult(
  app: App,
  ownerCookie: string,
  teamId: string,
  participantId?: string,
): Promise<string> {
  const memberCookie = await signIn(app, "second-adult");
  const personId = await personIdOf(app, memberCookie);
  const created = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "joining adult",
      recipientBinding: { kind: "confirmed_person", personId },
      ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
    },
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    (json(created) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: memberCookie },
    body: { token: inviteUrl.slice("/invite#".length) },
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

function selectLessonWeek(target: Lesson): Lesson {
  for (let week = 0; week < 52; week += 1) {
    now = MONDAY_2026_10_26_NOON_UTC + week * WEEK_MS;
    const lesson = selectLessonOfTheWeek(vendoredLessons, PILOT_AGE_BAND, now, TEAM_TIME_ZONE);
    if (lesson?.slug === target.slug) return lesson;
  }
  throw new Error(`No week selects ${target.slug}.`);
}

function answer(app: App, cookie: string, teamId: string, body: unknown) {
  return app.handle("POST", `/api/teams/${teamId}/lessons/current/answers`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function readCard(app: App, cookie: string, teamId: string, participantId: string) {
  return app.handle("GET", `/api/teams/${teamId}/participants/${participantId}/skill-card`, {
    headers: { cookie },
  });
}

interface SkillEventRow {
  readonly id: string;
  readonly participant_id: string;
  readonly event: string;
  readonly occurred_at: string;
  readonly created_at: string;
}

async function storedEvents(target: SkillTestApplication): Promise<SkillEventRow[]> {
  return (await target.sql
    .prepare("SELECT * FROM skill_events ORDER BY id")
    .all([])) as SkillEventRow[];
}

function wrongChoice(item: Lesson["quiz"][number]): number {
  return item.answer === 0 ? 1 : 0;
}

async function guardianFixture(target: SkillTestApplication, lesson: Lesson) {
  const { app } = target;
  const current = selectLessonWeek(lesson);
  const ownerCookie = await signIn(app);
  const { teamId, casey } = await seedTeam(app, ownerCookie);
  const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
  return { app, ownerCookie, guardianCookie, teamId, casey, lesson: current };
}

describe("Reel skill map", () => {
  it("maps only to active taxonomy skills", () => {
    const known = new Set(taxonomyV0.skills.map((skill) => skill.id));
    for (const skill of Object.values(reelSkillMap)) expect(known.has(skill)).toBe(true);
    expect(taxonomySkillForReelSkill("constructor")).toBeUndefined();
    expect(taxonomySkillForReelSkill("mistakes-are-ok")).toBeUndefined();
  });
});

describe("skill events from lesson answers", () => {
  it("writes exactly one check_passed event for a first correct answer", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");

    const response = await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(response.status).toBe(200);

    const rows = await storedEvents(flagOn);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error("Event row is missing.");
    const occurredAt = new Date(now).toISOString();
    expect(row.participant_id).toBe(casey);
    expect(row.occurred_at).toBe(occurredAt);
    expect(row.created_at).toBe(occurredAt);
    expect(JSON.parse(row.event)).toEqual({
      contract: "skill.events/v0",
      id: row.id,
      playerId: playerIdFor(casey),
      occurredAt,
      localDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: TEAM_TIME_ZONE,
      }).format(now),
      app: "snackday",
      type: "check_passed",
      skill: reelSkillMap[runToFirst.quizSkills?.[first.id] ?? ""],
      source: {
        kind: "reel-episode",
        id: `blooper/${lesson.slug}`,
        itemId: first.id,
      },
    });
    expect(row.event).not.toContain("Casey");
    expect(row.event).not.toContain(CASEY_BIRTH_DATE);
  });

  it("writes the event on the team's local date, not the UTC date", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    now += 15 * 60 * 60 * 1_000;
    const utcDate = new Date(now).toISOString().slice(0, 10);
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: TEAM_TIME_ZONE,
    }).format(now);
    expect(localDate).not.toBe(utcDate);

    await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    const [row] = await storedEvents(flagOn);
    expect(JSON.parse(row?.event ?? "{}")).toMatchObject({ localDate });
  });

  it("writes no second event for a repeat correct answer", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    const body = {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    };

    expect((await answer(app, guardianCookie, teamId, body)).status).toBe(200);
    now += 60_000;
    expect((await answer(app, guardianCookie, teamId, body)).status).toBe(200);

    expect(await storedEvents(flagOn)).toHaveLength(1);
  });

  it("writes no event for a wrong answer, and one once the answer turns correct", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");

    const wrong = await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: wrongChoice(first),
    });
    expect(wrong.status).toBe(200);
    expect(await storedEvents(flagOn)).toEqual([]);

    await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(await storedEvents(flagOn)).toHaveLength(1);
  });

  it("writes no event and logs one structured warning for an unmapped Reel skill", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      strikeOut.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    const reelSkill = strikeOut.quizSkills?.[first.id];
    expect(reelSkill).toBeDefined();
    expect(taxonomySkillForReelSkill(reelSkill ?? "")).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(response.status).toBe(200);

    expect(await storedEvents(flagOn)).toEqual([]);
    const unmapped = warn.mock.calls.filter(([line]) =>
      String(line).includes("skills.reel_skill_unmapped"),
    );
    expect(unmapped).toHaveLength(1);
    const logged = JSON.parse(String(unmapped[0]?.[0])) as Record<string, unknown>;
    expect(logged).toEqual({
      level: "warn",
      event: "skills.reel_skill_unmapped",
      reelSkill,
      source: `blooper/${lesson.slug}`,
      itemId: first.id,
    });
    expect(JSON.stringify(logged)).not.toContain(casey);
  });

  it("commits the answer and writes no event when the Reel quiz id breaks the event schema", async () => {
    const lesson = runToFirstTrailingHyphen.lesson;
    const { app, guardianCookie, teamId, casey } = await guardianFixture(trailingHyphen, lesson);
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    expect(first.id).toBe(TRAILING_HYPHEN_QUIZ_ID);
    expect(
      taxonomySkillForReelSkill(runToFirstTrailingHyphen.quizSkills?.[first.id] ?? ""),
    ).toBeDefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(response.status).toBe(200);

    const answers = await trailingHyphen.sql
      .prepare("SELECT quiz_id, outcome FROM lesson_answers WHERE participant_id = ?")
      .all([casey]);
    expect(answers).toEqual([{ quiz_id: TRAILING_HYPHEN_QUIZ_ID, outcome: "correct" }]);
    expect(await storedEvents(trailingHyphen)).toEqual([]);
    const invalid = warn.mock.calls.filter(([line]) =>
      String(line).includes("skills.event_invalid"),
    );
    expect(invalid).toHaveLength(1);
    const logged = JSON.parse(String(invalid[0]?.[0])) as Record<string, unknown>;
    expect(logged).toEqual({
      level: "warn",
      event: "skills.event_invalid",
      source: `blooper/${lesson.slug}`,
      itemId: TRAILING_HYPHEN_QUIZ_ID,
    });
    expect(JSON.stringify(logged)).not.toContain(casey);
  });

  it("stores exactly one check_passed per participant, source and quiz id when appended twice", async () => {
    const { casey, lesson } = await guardianFixture(flagOn, runToFirst.lesson);
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    const check = {
      participantId: casey,
      seriesId: lesson.seriesId,
      episodeSlug: lesson.slug,
      quizId: first.id,
      reelSkill: runToFirst.quizSkills?.[first.id],
      occurredAtMs: now,
      timeZone: TEAM_TIME_ZONE,
    };

    await flagOn.db.transaction(async (tx) => {
      await appendCheckPassed(tx, check);
      await appendCheckPassed(tx, { ...check, occurredAtMs: now + 1_000 });
    });

    const rows = await storedEvents(flagOn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurred_at).toBe(new Date(now).toISOString());
  });

  it("writes no event when the answer write is refused", async () => {
    const { app, ownerCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");

    const refused = await answer(app, ownerCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(refused.status).toBe(404);
    expect(await storedEvents(flagOn)).toEqual([]);
  });
});

describe("skill card API", () => {
  it("returns rate() over the stored events for a managing guardian", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    for (const item of lesson.quiz) {
      now += 60_000;
      await answer(app, guardianCookie, teamId, {
        participantId: casey,
        quizId: item.id,
        answer: item.answer,
      });
    }
    const rows = await storedEvents(flagOn);
    expect(rows).toHaveLength(lesson.quiz.length);

    const response = await readCard(app, guardianCookie, teamId, casey);
    expect(response.status).toBe(200);
    const localToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: TEAM_TIME_ZONE,
    }).format(now);
    const ageYears = wholeYearsBetween(CASEY_BIRTH_DATE, localToday);
    expect(ageYears).toBe(6);
    const expected = rate(
      parseSkillEvents(rows.map((row) => JSON.parse(row.event))),
      taxonomyV0,
      rulesV0,
      { ageYears },
    );
    expect(json(response)).toEqual(expected);
    expect(expected.overall).toBeGreaterThan(0);
    expect(expected.areas.map((area) => area.area)).not.toContain("hitting");
  });

  it("counts whole years at the team's local today", () => {
    expect(wholeYearsBetween("2020-04-09", "2026-04-08")).toBe(5);
    expect(wholeYearsBetween("2020-04-09", "2026-04-09")).toBe(6);
    expect(wholeYearsBetween("2020-02-29", "2026-02-28")).toBe(5);
    expect(wholeYearsBetween("2020-02-29", "2026-03-01")).toBe(6);
  });

  it("returns an empty card when the child has no events", async () => {
    const { app, guardianCookie, teamId, casey } = await guardianFixture(flagOn, runToFirst.lesson);
    const response = await readCard(app, guardianCookie, teamId, casey);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual(rate([], taxonomyV0, rulesV0, { ageYears: 6 }));
  });

  it("refuses a coach who is not the child's guardian", async () => {
    const { app, ownerCookie, teamId, casey } = await guardianFixture(flagOn, runToFirst.lesson);

    const response = await readCard(app, ownerCookie, teamId, casey);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
  });

  it("refuses a guardian whose relationship only grants participant.read", async () => {
    const { app, sql } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedTeam(app, ownerCookie);
    const readerCookie = await joinAsSecondAdult(app, ownerCookie, teamId);
    const stamp = new Date(now).toISOString();
    await sql
      .prepare(
        "INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run([
        "read-only-edge",
        await personIdOf(app, readerCookie),
        casey,
        "parent",
        "active",
        JSON.stringify(["participant.read"]),
        stamp,
        stamp,
      ]);

    const response = await readCard(app, readerCookie, teamId, casey);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
  });

  it("refuses a stranger and an anonymous caller", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedTeam(app, ownerCookie);
    const strangerCookie = await signIn(app, "second-adult");

    const stranger = await readCard(app, strangerCookie, teamId, casey);
    expect(stranger.status).toBe(404);
    expect(json(stranger)).toEqual({ error: "team not found" });

    const anonymous = await app.handle(
      "GET",
      `/api/teams/${teamId}/participants/${casey}/skill-card`,
      {},
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("player card on /app", () => {
  it("shows the managing guardian an overall and each area rating", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    for (const item of lesson.quiz) {
      await answer(app, guardianCookie, teamId, {
        participantId: casey,
        quizId: item.id,
        answer: item.answer,
      });
    }
    const card = json(await readCard(app, guardianCookie, teamId, casey)) as {
      overall: number;
      areas: { area: string; rating: number }[];
    };

    const html = await pageText(
      await app.handle("GET", "/app", { headers: { cookie: guardianCookie } }),
    );
    expect(html).toContain('aria-label="Player card"');
    expect(html.indexOf("Lesson of the week")).toBeLessThan(html.indexOf("Player card"));
    expect(html).toContain("Casey Kid");
    expect(html).toContain(`<span class="text-2xl font-black">${card.overall}</span>`);
    expect(html).toContain("Baserunning");
    expect(html).toContain("Infield");
    expect(card.areas.length).toBeGreaterThan(0);
  });

  it("shows no player card to a coach who manages no child", async () => {
    const { app, ownerCookie } = await guardianFixture(flagOn, runToFirst.lesson);

    const html = await pageText(
      await app.handle("GET", "/app", { headers: { cookie: ownerCookie } }),
    );
    expect(html).toContain("Lesson of the week");
    expect(html).not.toContain("Player card");
  });

  it("hides the route and the section when the flag is off", async () => {
    const { app, guardianCookie, teamId, casey } = await guardianFixture(
      flagOff,
      runToFirst.lesson,
    );

    const route = await readCard(app, guardianCookie, teamId, casey);
    expect(route.status).toBe(404);
    expect(await pageText(route)).not.toContain("overall");

    const page = await app.handle("GET", "/app", {
      headers: { cookie: guardianCookie },
    });
    expect(page.status).toBe(200);
    const html = await pageText(page);
    expect(html).toContain("Coach Pitch Comets");
    expect(html).not.toContain("Player card");
  });
});
