import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { PILOT_AGE_BAND, selectLessonOfTheWeek } from "@snackday/domain";
import type { Lesson } from "@snackday/domain";
import { parseSkillEvents, rate, rulesV0, taxonomyV0 } from "@snackday/skill-engine";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { staticLessonCatalog } from "../app/lessons/catalog";
import type { CatalogEpisode } from "../app/lessons/catalog";
import { parseReelEpisode } from "../app/lessons/reel-contract";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { reelSkillMap, taxonomySkillForReelSkill } from "../app/skills/reel-skill-map";
import { LessonAnswers, submitLessonAnswer } from "../app/lessons/lesson-answers";
import type { AnswerPoster, LessonAnswerPrompt } from "../app/lessons/lesson-answers";
import { areaLabel, LivePlayerCards } from "../app/skills/player-card";
import type { PlayerCardEntry } from "../app/skills/player-card";
import {
  applyPlayerCardUpdate,
  refreshPlayerCard,
  skillCardUrl,
  subscribePlayerCardUpdates,
} from "../app/skills/player-card-updates";
import type { PlayerCardUpdate } from "../app/skills/player-card-updates";
import { appendCheckPassed, PLAYER_CARD_RULESET, playerIdFor } from "../app/skills/skill-events";
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
const LITTLE_LEAGUE_AREAS = [
  "hitting",
  "bunting",
  "baserunning",
  "infield",
  "outfield",
  "pitching",
  "baseball-iq",
  "mental",
];
const littleLeague = { ruleset: PLAYER_CARD_RULESET };

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

interface SeedChild {
  readonly displayName: string;
  readonly birthDate?: string;
}

const defaultChildren: readonly SeedChild[] = [
  { displayName: "Casey Kid", birthDate: CASEY_BIRTH_DATE },
  { displayName: "Rowan Kid", birthDate: "2020-06-14" },
];

async function seedTeam(
  app: App,
  cookie: string,
  name = "Coach Pitch Comets",
  children: readonly SeedChild[] = defaultChildren,
) {
  const team = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name },
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
  for (const body of children) {
    const child = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      { headers: { ...sameOrigin, cookie }, body },
    );
    expect(child.status).toBe(201);
    participantIds.push(
      (json(child) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  const [casey, rowan] = participantIds;
  if (casey === undefined || rowan === undefined) throw new Error("Seed data is missing.");
  return { teamId, seasonId, casey, rowan };
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
  const { teamId, casey, rowan } = await seedTeam(app, ownerCookie);
  const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
  return { app, ownerCookie, guardianCookie, teamId, casey, rowan, lesson: current };
}

describe("Reel skill map", () => {
  it("maps only to active taxonomy skills", () => {
    const known = new Set(taxonomyV0.skills.map((skill) => skill.id));
    for (const skill of Object.values(reelSkillMap)) expect(known.has(skill)).toBe(true);
    expect(taxonomySkillForReelSkill("constructor")).toBeUndefined();
    expect(taxonomySkillForReelSkill("no-such-reel-skill")).toBeUndefined();
  });

  it("maps every strike-out episode skill to mental.failure", () => {
    const strikeOutSkills = readManifest("its-ok-to-strike-out.v1.episode.json").quiz.map(
      (item) => item.skill ?? "",
    );
    expect(strikeOutSkills.length).toBeGreaterThan(0);
    for (const skill of [...strikeOutSkills, "cheer-teammates"]) {
      expect(taxonomySkillForReelSkill(skill)).toBe("mental.failure");
    }
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
    const { casey, lesson } = await guardianFixture(flagOn, strikeOut.lesson);
    const [first] = lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");
    const reelSkill = "no-such-reel-skill";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await flagOn.db.transaction((tx) =>
      appendCheckPassed(tx, {
        participantId: casey,
        seriesId: lesson.seriesId,
        episodeSlug: lesson.slug,
        quizId: first.id,
        reelSkill,
        occurredAtMs: now,
        timeZone: TEAM_TIME_ZONE,
      }),
    );

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

  it("writes a mental.failure check_passed for a correct strike-out answer", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      strikeOut.lesson,
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
    expect(rows.map((row) => JSON.parse(row.event) as Record<string, unknown>)).toMatchObject([
      {
        type: "check_passed",
        skill: "mental.failure",
        source: { kind: "reel-episode", id: `blooper/${lesson.slug}`, itemId: first.id },
      },
    ]);
    const card = json(await readCard(app, guardianCookie, teamId, casey)) as {
      areas: { area: string; rating: number }[];
    };
    expect(card.areas.find((area) => area.area === "mental")?.rating).toBe(1);
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
    const expected = rate(
      parseSkillEvents(rows.map((row) => JSON.parse(row.event))),
      taxonomyV0,
      rulesV0,
      littleLeague,
    );
    expect(json(response)).toEqual(expected);
    expect(expected.skills.map((skill) => [skill.skill, skill.rating])).toEqual([
      ["infield.ready-position", 1],
      ["baserunning.out-of-the-box", 3],
    ]);
    expect(expected.areas).toEqual(
      LITTLE_LEAGUE_AREAS.map((area) => ({ area, rating: area === "baserunning" ? 1 : 0 })),
    );
    expect(expected.overall).toBe(0);
  });

  it("rates with the Little League rule set", () => {
    expect(PLAYER_CARD_RULESET).toBe("little-league");
  });

  it("returns a Little League card for a child with no birth date", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, casey } = await seedTeam(app, ownerCookie, "No Birthday Bats", [
      { displayName: "Sam Kid" },
      { displayName: "Alex Kid" },
    ]);
    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);

    const response = await readCard(app, guardianCookie, teamId, casey);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual(rate([], taxonomyV0, rulesV0, littleLeague));
  });

  it("returns an empty card when the child has no events", async () => {
    const { app, guardianCookie, teamId, casey } = await guardianFixture(flagOn, runToFirst.lesson);
    const response = await readCard(app, guardianCookie, teamId, casey);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual(rate([], taxonomyV0, rulesV0, littleLeague));
  });

  it("lets a coach who is not the child's guardian read the card", async () => {
    const { app, ownerCookie, teamId, casey } = await guardianFixture(flagOn, runToFirst.lesson);

    const response = await readCard(app, ownerCookie, teamId, casey);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual(rate([], taxonomyV0, rulesV0, littleLeague));
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
    expect(html).toContain("Mental");
    expect(html).toContain(">Pitching</dt>");
    expect(html).not.toContain(">First base</dt>");
    expect(html).not.toContain(">Catching</dt>");
    expect(card.areas.length).toBeGreaterThan(0);
  });

  it("shows one card per managed child across every team", async () => {
    const { app, sql } = flagOn;
    const ownerCookie = await signIn(app);
    const first = await seedTeam(app, ownerCookie);
    const second = await seedTeam(app, ownerCookie, "Majors Meteors", [
      { displayName: "Jordan Kid" },
      { displayName: "Riley Kid" },
    ]);
    await joinAsSecondAdult(app, ownerCookie, first.teamId, first.casey);
    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, second.teamId, second.casey);
    const stamp = new Date(now).toISOString();
    await sql
      .prepare(
        "INSERT INTO memberships (id, team_id, season_id, member_kind, member_person_id, member_participant_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run([
        "casey-on-second-team",
        second.teamId,
        second.seasonId,
        "participant",
        null,
        first.casey,
        "active",
        stamp,
        stamp,
      ]);

    const html = await pageText(
      await app.handle("GET", "/app", { headers: { cookie: guardianCookie } }),
    );
    const section = html.slice(
      html.indexOf('aria-label="Player card"'),
      html.indexOf('aria-label="Roster"'),
    );
    expect(section.split('<span class="text-muted-foreground">Overall </span>')).toHaveLength(3);
    expect(section).toContain("Casey Kid");
    expect(section).toContain("Jordan Kid");
    expect(section).not.toContain("Riley Kid");
  });

  it("shows a coach who manages no child a card for every rostered child", async () => {
    const { app, ownerCookie } = await guardianFixture(flagOn, runToFirst.lesson);

    const html = await pageText(
      await app.handle("GET", "/app", { headers: { cookie: ownerCookie } }),
    );
    expect(html).toContain("Lesson of the week");
    const section = html.slice(html.indexOf('aria-label="Player card"'));
    expect(section).toContain("Casey Kid");
    expect(section).toContain("Rowan Kid");
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

describe("player card refresh after an answer", () => {
  function cardGetter(app: App, cookie: string, urls: string[]) {
    return async (url: string) => {
      urls.push(url);
      const response = await app.handle("GET", url, { headers: { cookie } });
      return { ok: response.status === 200, json: json(response) };
    };
  }

  it("re-fetches the card endpoint and updates only that child's card", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const target = new EventTarget();
    let players: PlayerCardEntry[] = [
      { participantId: casey, label: "Casey Kid", overall: 0, areas: [] },
      { participantId: "participant_other", label: "Other Kid", overall: 7, areas: [] },
    ];
    const unsubscribe = subscribePlayerCardUpdates((update) => {
      players = applyPlayerCardUpdate(players, update);
    }, target);
    const post = async (url: string, body: unknown) => {
      const response = await app.handle("POST", url, {
        headers: { ...sameOrigin, cookie: guardianCookie },
        body,
      });
      return { ok: response.status === 200, json: json(response) };
    };

    for (const item of lesson.quiz) {
      const result = await submitLessonAnswer(teamId, casey, item.id, item.answer, post);
      expect(result?.outcome).toBe("correct");
    }
    const urls: string[] = [];
    await refreshPlayerCard(teamId, casey, {
      target,
      get: cardGetter(app, guardianCookie, urls),
    });
    unsubscribe();

    const card = json(await readCard(app, guardianCookie, teamId, casey)) as PlayerCardUpdate;
    expect(urls).toEqual([skillCardUrl(teamId, casey)]);
    expect(players).toEqual([
      { participantId: casey, label: "Casey Kid", overall: card.overall, areas: card.areas },
      { participantId: "participant_other", label: "Other Kid", overall: 7, areas: [] },
    ]);
    expect(card.areas.find((area) => area.area === "baserunning")?.rating).toBe(1);
  });

  it("publishes nothing when the card read is refused or fails", async () => {
    const { app, guardianCookie, teamId, casey, rowan } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const target = new EventTarget();
    const updates: PlayerCardUpdate[] = [];
    const unsubscribe = subscribePlayerCardUpdates((update) => updates.push(update), target);

    const refused = await refreshPlayerCard(teamId, rowan, {
      target,
      get: cardGetter(app, guardianCookie, []),
    });
    const failed = await refreshPlayerCard(teamId, casey, {
      target,
      get: () => Promise.reject(new Error("offline")),
    });
    unsubscribe();

    expect(refused).toBeUndefined();
    expect(failed).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("shows the newer card when two refreshes for one child resolve in reverse order", async () => {
    const target = new EventTarget();
    const participantId = "participant_reverse_order";
    let players: PlayerCardEntry[] = [{ participantId, label: "Casey Kid", overall: 0, areas: [] }];
    const unsubscribe = subscribePlayerCardUpdates((update) => {
      players = applyPlayerCardUpdate(players, update);
    }, target);
    const responses: ((response: { ok: boolean; json: unknown }) => void)[] = [];
    const get = () =>
      new Promise<{ ok: boolean; json: unknown }>((resolve) => {
        responses.push(resolve);
      });

    const older = refreshPlayerCard("team_x", participantId, { target, get });
    const newer = refreshPlayerCard("team_x", participantId, { target, get });
    const [resolveOlder, resolveNewer] = responses;
    if (resolveOlder === undefined || resolveNewer === undefined) {
      throw new Error("Both refreshes must request the card.");
    }
    const newerCard = { overall: 2, areas: [{ area: "hitting", rating: 2 }] };
    resolveNewer({ ok: true, json: newerCard });
    await newer;
    resolveOlder({ ok: true, json: { overall: 1, areas: [{ area: "hitting", rating: 1 }] } });
    expect(await older).toBeUndefined();
    unsubscribe();

    expect(players).toEqual([{ participantId, label: "Casey Kid", ...newerCard }]);
  });

  it("stops listening after unsubscribe", async () => {
    const target = new EventTarget();
    const updates: PlayerCardUpdate[] = [];
    const unsubscribe = subscribePlayerCardUpdates((update) => updates.push(update), target);
    unsubscribe();
    await refreshPlayerCard("team_x", "participant_x", {
      target,
      get: () => Promise.resolve({ ok: true, json: { overall: 3, areas: [] } }),
    });
    expect(updates).toEqual([]);
  });
});

describe("lesson answer island mounted with the live player cards", () => {
  let createRoot: typeof import("react-dom/client").createRoot;
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const roots: Root[] = [];
  let closeWindow: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "https://snackday.test/" });
    closeWindow = () => dom.happyDOM.close();
    const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [key, value] of Object.entries(globals)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    ({ createRoot } = await import("react-dom/client"));
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(() => root.unmount());
    document.body.innerHTML = "";
  });

  afterAll(async () => {
    await closeWindow();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });

  async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(() => root.render(element));
    return container;
  }

  async function settle(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }

  async function click(button: HTMLElement | undefined | null): Promise<void> {
    if (button === undefined || button === null) throw new Error("Button is missing.");
    await act(async () => {
      button.click();
    });
  }

  function cardText(container: HTMLElement, label: string): string | undefined {
    return [...container.querySelectorAll("li")].find(
      (item) => item.querySelector("p")?.textContent === label,
    )?.textContent;
  }

  function expectedCardText(player: PlayerCardEntry): string {
    return `${player.label}Overall ${player.overall}${player.areas
      .map((entry) => `${areaLabel(entry.area)}${entry.rating}`)
      .join("")}`;
  }

  it("refreshes the card after a correct answer and not after a wrong one", async () => {
    const quiz: LessonAnswerPrompt[] = [
      { id: "where-to-run", prompt: "Where do you run?", choices: ["First base", "Third base"] },
    ];
    const post: AnswerPoster = (_url, body) => {
      const { answer } = body as { answer: number };
      const outcome = answer === 0 ? "correct" : "try_again";
      return Promise.resolve({
        ok: true,
        json: {
          answer: { participantId: "participant_casey", quizId: "where-to-run", answer, outcome },
          feedback: outcome === "correct" ? "Yes!" : "Not quite.",
        },
      });
    };
    const refreshed: string[] = [];
    const refreshCard = (_teamId: string, participantId: string) => {
      refreshed.push(participantId);
      return Promise.resolve(undefined);
    };
    const answers = await mount(
      createElement(LessonAnswers, {
        teamId: "team_comets",
        quiz,
        players: [{ participantId: "participant_casey", label: "Casey Kid" }],
        answers: [],
        post,
        refreshCard,
      }),
    );
    const [right, wrong] = answers.querySelectorAll("button");

    await click(wrong);
    await settle(() => answers.textContent?.includes("Not quite.") ?? false);
    expect(answers.textContent).toContain("Not quite.");
    expect(refreshed).toEqual([]);

    await click(right);
    await settle(() => refreshed.length > 0);
    expect(answers.textContent).toContain("Yes!");
    expect(refreshed).toEqual(["participant_casey"]);
  });

  it("updates the answering child's rendered card and leaves another child's card alone", async () => {
    const { app, guardianCookie, teamId, casey, lesson } = await guardianFixture(
      flagOn,
      runToFirst.lesson,
    );
    const rowan = "participant_rowan_static";
    const target = new EventTarget();
    const before = json(await readCard(app, guardianCookie, teamId, casey)) as PlayerCardUpdate;
    const rowanCard: PlayerCardEntry = {
      participantId: rowan,
      label: "Rowan Kid",
      overall: 7,
      areas: [{ area: "hitting", rating: 7 }],
    };
    const caseyBefore: PlayerCardEntry = {
      participantId: casey,
      label: "Casey Kid",
      overall: before.overall,
      areas: before.areas,
    };
    const post: AnswerPoster = async (url, body) => {
      const response = await app.handle("POST", url, {
        headers: { ...sameOrigin, cookie: guardianCookie },
        body,
      });
      return { ok: response.status === 200, json: json(response) };
    };
    const get = async (url: string) => {
      const response = await app.handle("GET", url, { headers: { cookie: guardianCookie } });
      return { ok: response.status === 200, json: json(response) };
    };
    const refreshCard = (cardTeamId: string, participantId: string) =>
      refreshPlayerCard(cardTeamId, participantId, { target, get });

    const cards = await mount(
      createElement(LivePlayerCards, { players: [caseyBefore, rowanCard], target }),
    );
    const answers = await mount(
      createElement(LessonAnswers, {
        teamId,
        quiz: lesson.quiz.map(({ id, prompt, choices }) => ({ id, prompt, choices })),
        players: [{ participantId: casey, label: "Casey Kid" }],
        answers: [],
        post,
        refreshCard,
      }),
    );
    expect(cardText(cards, "Casey Kid")).toBe(expectedCardText(caseyBefore));

    const questions = [...answers.querySelectorAll("ol > li")];
    for (const [index, item] of lesson.quiz.entries()) {
      await click(questions[index]?.querySelectorAll("button")[item.answer]);
      await settle(() => questions[index]?.querySelector('[role="status"]') !== null);
    }
    const after = json(await readCard(app, guardianCookie, teamId, casey)) as PlayerCardUpdate;
    const caseyAfter = { ...caseyBefore, overall: after.overall, areas: after.areas };
    expect(expectedCardText(caseyAfter)).not.toBe(expectedCardText(caseyBefore));
    await settle(() => cardText(cards, "Casey Kid") === expectedCardText(caseyAfter));

    expect(cardText(cards, "Casey Kid")).toBe(expectedCardText(caseyAfter));
    expect(cardText(cards, "Rowan Kid")).toBe(expectedCardText(rowanCard));
  });
});
