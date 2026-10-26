import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import {
  isoWeekIndex,
  lessonCompleted,
  PILOT_AGE_BAND,
  selectLessonOfTheWeek,
} from "@snackday/domain";
import type { Lesson } from "@snackday/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_FAILURE_TTL_MS,
  reelLessonCatalog,
  staticLessonCatalog,
} from "../app/lessons/catalog";
import {
  LessonAnswers,
  LessonAnswersShell,
  mergeLessonAnswer,
  submitLessonAnswer,
} from "../app/lessons/lesson-answers";
import { formatLessonDuration } from "../app/lessons/lesson-card";
import { lessonServices, recordLessonAnswer } from "../app/lessons/lessons";
import { parseReelCatalog, parseReelEpisode } from "../app/lessons/reel-contract";
import { writeSeasonLessonAgeBand } from "../app/lib/server/teams";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const contractDirectory = join(import.meta.dirname, "../../../contracts/reel-episode-v0");

function vendored(name: string): unknown {
  return JSON.parse(readFileSync(join(contractDirectory, name), "utf8"));
}

function parsedLesson(name: string): Lesson {
  const result = parseReelEpisode(vendored(name));
  if (!result.ok) throw new Error(`Vendored manifest ${name} must parse.`);
  return result.value;
}

const strikeOut = parsedLesson("its-ok-to-strike-out.v1.episode.json");
const runToFirst = parsedLesson("run-to-first.v1.episode.json");
const vendoredLessons = [runToFirst, strikeOut];

const MONDAY_2026_10_26_NOON_UTC = Date.UTC(2026, 9, 26, 12);
const DAY_MS = 24 * 60 * 60 * 1_000;
const TEAM_TIME_ZONE = "America/Los_Angeles";

let now = MONDAY_2026_10_26_NOON_UTC;
const clock = () => now;

interface LessonTestApplication {
  readonly app: App;
  readonly sql: Awaited<ReturnType<typeof openSqlite>>["db"];
  readonly db: Db;
}

async function lessonTestApplication(enabled: boolean): Promise<LessonTestApplication> {
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
    lessons: { enabled, catalog: staticLessonCatalog(vendoredLessons) },
  });
  await registerRuntimePages(config.app);
  return { app: await createApp(config), sql, db };
}

let flagOn: LessonTestApplication;
let flagOff: LessonTestApplication;

beforeAll(async () => {
  flagOn = await lessonTestApplication(true);
  flagOff = await lessonTestApplication(false);
});

async function clearState(target: LessonTestApplication) {
  await target.sql.exec(
    "DELETE FROM lesson_answers; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(async () => {
  now = MONDAY_2026_10_26_NOON_UTC;
  await clearState(flagOn);
  await clearState(flagOff);
});
afterAll(async () => {
  await clearState(flagOn);
  await clearState(flagOff);
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
  return text
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
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
    ["Casey Kid", "2020-04-09"],
    ["Rowan Kid", "2020-06-14"],
  ] as const) {
    const child = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        headers: { ...sameOrigin, cookie },
        body: { displayName, birthDate },
      },
    );
    expect(child.status).toBe(201);
    participantIds.push(
      (json(child) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  return { teamId, seasonId, participantIds };
}

async function joinAsSecondAdult(
  app: App,
  ownerCookie: string,
  teamId: string,
  participantId?: string,
): Promise<string> {
  const memberCookie = await signIn(app, "second-adult");
  const session = await app.handle("GET", "/api/session", { headers: { cookie: memberCookie } });
  const personId = (json(session) as { person: { id: string } }).person.id;
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

function currentLesson(): Lesson {
  const lesson = selectLessonOfTheWeek(vendoredLessons, PILOT_AGE_BAND, now, TEAM_TIME_ZONE);
  if (lesson === undefined) throw new Error("A vendored lesson must fit the pilot age band.");
  return lesson;
}

function answer(app: App, cookie: string, teamId: string, body: unknown) {
  return app.handle("POST", `/api/teams/${teamId}/lessons/current/answers`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

describe("Reel episode parser", () => {
  it("accepts both vendored reel.episode/v0 manifests as Snackday lessons", () => {
    expect(strikeOut).toMatchObject({
      seriesId: "blooper",
      slug: "its-ok-to-strike-out",
      number: 1,
      title: "It's OK to Strike Out!",
      ages: { min: 5, max: 12 },
      pageUrl: "https://learn.dimasciobaseball.com/episodes/its-ok-to-strike-out/",
      posterUrl: "https://media.dimasciobaseball.com/episodes/its-ok-to-strike-out/v1/poster.jpg",
      durationSeconds: 212.6,
    });
    expect(strikeOut.quiz.map((item) => item.id)).toEqual([
      "after-a-strikeout",
      "eyes-on-the-ball",
      "is-missing-ok",
    ]);
    expect(runToFirst.slug).toBe("run-to-first");
    expect(runToFirst.ages).toEqual({ min: 5, max: 7 });
    expect(runToFirst.quiz).toHaveLength(3);
    expect(JSON.stringify(runToFirst)).not.toContain("transcript");
  });

  it("rejects a manifest whose contract id is not reel.episode/v0", () => {
    const manifest = vendored("run-to-first.v1.episode.json") as Record<string, unknown>;
    expect(parseReelEpisode({ ...manifest, schema: "reel.episode/v1" })).toEqual({
      ok: false,
      reason: "wrong_contract",
    });
    const { schema: _schema, ...unlabelled } = manifest;
    expect(parseReelEpisode(unlabelled)).toEqual({ ok: false, reason: "wrong_contract" });
    expect(parseReelEpisode(null)).toEqual({ ok: false, reason: "wrong_contract" });
  });

  it("rejects a manifest that claims v0 but breaks it", () => {
    const manifest = vendored("run-to-first.v1.episode.json") as { quiz: { answer: number }[] };
    const broken = structuredClone(manifest);
    if (broken.quiz[0] !== undefined) broken.quiz[0].answer = 9;
    expect(parseReelEpisode(broken)).toEqual({ ok: false, reason: "invalid" });
  });

  it("tolerates added v0 fields", () => {
    const manifest = vendored("run-to-first.v1.episode.json") as Record<string, unknown>;
    expect(parseReelEpisode({ ...manifest, rating: "G" }).ok).toBe(true);
  });

  it("reads manifest urls from the vendored catalog and rejects other catalog contracts", () => {
    expect(parseReelCatalog(vendored("catalog.json"))).toEqual({
      ok: true,
      value: [
        "https://media.dimasciobaseball.com/episodes/its-ok-to-strike-out/v1/episode.json",
        "https://media.dimasciobaseball.com/episodes/run-to-first/v1/episode.json",
      ],
    });
    expect(parseReelCatalog({ schema: "reel.episode/v0", episodes: [] }).ok).toBe(false);
  });

  it("loads the catalog through an injected fetcher and caches manifests by url", async () => {
    const requested: string[] = [];
    const responses = new Map<string, unknown>([
      ["https://learn.dimasciobaseball.com/episodes.json", vendored("catalog.json")],
      [
        "https://media.dimasciobaseball.com/episodes/its-ok-to-strike-out/v1/episode.json",
        vendored("its-ok-to-strike-out.v1.episode.json"),
      ],
      [
        "https://media.dimasciobaseball.com/episodes/run-to-first/v1/episode.json",
        { ...(vendored("run-to-first.v1.episode.json") as object), schema: "other/v9" },
      ],
    ]);
    const catalog = reelLessonCatalog({
      clock,
      fetchJson: (url) => {
        requested.push(url);
        return Promise.resolve(responses.get(url));
      },
    });

    const lessons = await catalog.load();
    expect(lessons.map((lesson) => lesson.slug)).toEqual(["its-ok-to-strike-out"]);
    await catalog.load();
    expect(requested).toHaveLength(3);

    now += 6 * 60 * 1_000;
    await catalog.load();
    expect(
      requested.filter((url) => url.endsWith("its-ok-to-strike-out/v1/episode.json")),
    ).toHaveLength(1);
    expect(requested.filter((url) => url.endsWith("episodes.json"))).toHaveLength(2);
  });
});

describe("lesson of the week selection", () => {
  it("counts ISO weeks from Monday", () => {
    expect(isoWeekIndex(Date.UTC(1970, 0, 5))).toBe(0);
    expect(isoWeekIndex(Date.UTC(1970, 0, 11, 23, 59))).toBe(0);
    expect(isoWeekIndex(Date.UTC(1970, 0, 12))).toBe(1);
    expect(isoWeekIndex(Date.UTC(1970, 0, 4))).toBe(-1);
  });

  it("keeps one lesson for a whole week and rotates every Monday", () => {
    const monday = MONDAY_2026_10_26_NOON_UTC;
    const pick = (instant: number) =>
      selectLessonOfTheWeek(vendoredLessons, PILOT_AGE_BAND, instant, "UTC")?.slug;

    const thisWeek = pick(monday);
    for (let day = 1; day < 7; day += 1) expect(pick(monday + day * DAY_MS)).toBe(thisWeek);
    const nextWeek = pick(monday + 7 * DAY_MS);
    expect(nextWeek).not.toBe(thisWeek);
    expect(pick(monday + 14 * DAY_MS)).toBe(thisWeek);
    expect(new Set([thisWeek, nextWeek])).toEqual(
      new Set(["its-ok-to-strike-out", "run-to-first"]),
    );
  });

  it("is independent of catalog order", () => {
    const forward = selectLessonOfTheWeek(vendoredLessons, PILOT_AGE_BAND, now);
    const reversed = selectLessonOfTheWeek([...vendoredLessons].reverse(), PILOT_AGE_BAND, now);
    expect(forward?.slug).toBe(reversed?.slug);
  });

  it("rolls the week over at the team's local Monday", () => {
    const sundayNightInLosAngeles = Date.UTC(2026, 10, 2, 7, 30);
    expect(isoWeekIndex(sundayNightInLosAngeles, "UTC")).toBe(
      isoWeekIndex(sundayNightInLosAngeles, TEAM_TIME_ZONE) + 1,
    );
  });

  it("only picks episodes whose age range covers the team's band", () => {
    const olderOnly = { ...strikeOut, slug: "older-only", ages: { min: 8, max: 12 } };
    for (let week = 0; week < 4; week += 1) {
      const pick = selectLessonOfTheWeek(
        [olderOnly, runToFirst],
        PILOT_AGE_BAND,
        MONDAY_2026_10_26_NOON_UTC + week * 7 * DAY_MS,
      );
      expect(pick?.slug).toBe("run-to-first");
    }
    expect(selectLessonOfTheWeek([olderOnly], PILOT_AGE_BAND, now)).toBeUndefined();
  });

  it("formats the episode duration for the card", () => {
    expect(formatLessonDuration(212.6)).toBe("3 min 33 sec");
    expect(formatLessonDuration(120)).toBe("2 min");
    expect(formatLessonDuration(42)).toBe("42 sec");
  });
});

describe("lesson completion records", () => {
  it("writes and reads answers keyed by participant, series, episode, and quiz item", async () => {
    const { app, sql } = flagOn;
    const coachCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, coachCookie);
    const [casey] = participantIds;
    const lesson = currentLesson();
    const [first] = lesson.quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const cookie = await joinAsSecondAdult(app, coachCookie, teamId, casey);
    const wrongChoice = first.answer === 0 ? 1 : 0;

    const wrong = await answer(app, cookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: wrongChoice,
    });
    expect(wrong.status).toBe(200);
    expect(json(wrong)).toEqual({
      answer: {
        participantId: casey,
        seriesId: "blooper",
        episodeSlug: lesson.slug,
        quizId: first.id,
        answer: wrongChoice,
        outcome: "try_again",
        answeredAt: new Date(now).toISOString(),
      },
      feedback: first.feedback.wrong,
    });

    now += 60_000;
    const right = await answer(app, cookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(json(right)).toMatchObject({
      answer: { outcome: "correct", answeredAt: new Date(now).toISOString() },
      feedback: first.feedback.correct,
    });

    const retry = await answer(app, cookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: wrongChoice,
    });
    expect(retry.status).toBe(200);
    expect(json(retry)).toMatchObject({
      answer: { outcome: "correct", answer: first.answer },
      feedback: first.feedback.correct,
    });

    const rows = (await sql
      .prepare("SELECT * FROM lesson_answers WHERE participant_id = ?")
      .all([casey])) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "answer_index",
      "answered_at",
      "created_at",
      "episode_slug",
      "id",
      "outcome",
      "participant_id",
      "quiz_id",
      "recorded_by_person_id",
      "series_id",
    ]);
    expect(JSON.stringify(rows)).not.toContain("Casey");

    const read = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie },
    });
    expect(read.status).toBe(200);
    const view = json(read) as {
      lesson: Lesson;
      progress: { participantId: string; answers: { quizId: string; outcome: string }[] }[];
    };
    expect(view.lesson.slug).toBe(lesson.slug);
    expect(view.progress.find((entry) => entry.participantId === casey)?.answers).toEqual([
      expect.objectContaining({ quizId: first.id, outcome: "correct" }),
    ]);

    const coachRead = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie: coachCookie },
    });
    expect(json(coachRead)).toMatchObject({ progress: [], completedParticipants: 0 });
  });

  it("refuses a coach who is not the child's guardian and shows the coach no per-child answers", async () => {
    const { app } = flagOn;
    const coachCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, coachCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const guardianCookie = await joinAsSecondAdult(app, coachCookie, teamId, casey);
    expect(
      (
        await answer(app, guardianCookie, teamId, {
          participantId: casey,
          quizId: first.id,
          answer: first.answer,
        })
      ).status,
    ).toBe(200);

    const coachWrite = await answer(app, coachCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer === 0 ? 1 : 0,
    });
    expect(coachWrite.status).toBe(404);
    expect(json(coachWrite)).toEqual({ error: "participant not found" });

    const coachRead = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie: coachCookie },
    });
    expect((json(coachRead) as { progress: unknown[] }).progress).toEqual([]);
  });

  it("refuses a coach whose guardian relationship only grants participant.read", async () => {
    const { app, sql } = flagOn;
    const coachCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, coachCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const session = await app.handle("GET", "/api/session", { headers: { cookie: coachCookie } });
    const coachPersonId = (json(session) as { person: { id: string } }).person.id;
    const stamp = new Date(now).toISOString();
    await sql
      .prepare(
        "INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run([
        "read-only-edge",
        coachPersonId,
        casey,
        "parent",
        "active",
        JSON.stringify(["participant.read"]),
        stamp,
        stamp,
      ]);

    const write = await answer(app, coachCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(write.status).toBe(404);
    expect(json(write)).toEqual({ error: "participant not found" });
  });

  it("gives a coach the completed-participant count for the current lesson", async () => {
    const { app } = flagOn;
    const cookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, cookie);
    const lesson = currentLesson();
    const [casey] = participantIds;
    if (casey === undefined) throw new Error("Seed data is missing.");
    const guardianCookie = await joinAsSecondAdult(app, cookie, teamId, casey);

    for (const item of lesson.quiz) {
      expect(
        (
          await answer(app, guardianCookie, teamId, {
            participantId: casey,
            quizId: item.id,
            answer: item.answer,
          })
        ).status,
      ).toBe(200);
    }

    const read = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie },
    });
    expect((json(read) as { completedParticipants: number }).completedParticipants).toBe(1);
    expect(lessonCompleted(lesson, [])).toBe(false);
  });

  it("lets a guardian answer for their own child only and hides the coach count", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey, rowan] = participantIds;
    if (casey === undefined || rowan === undefined) throw new Error("Seed data is missing.");
    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const [first] = currentLesson().quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");

    const own = await answer(app, guardianCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(own.status).toBe(200);
    const other = await answer(app, guardianCookie, teamId, {
      participantId: rowan,
      quizId: first.id,
      answer: first.answer,
    });
    expect(other.status).toBe(404);
    expect(json(other)).toEqual({ error: "participant not found" });

    const read = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie: guardianCookie },
    });
    const view = json(read) as Record<string, unknown> & {
      progress: { participantId: string }[];
    };
    expect(view.progress.map((entry) => entry.participantId)).toEqual([casey]);
    expect(view).not.toHaveProperty("completedParticipants");
  });

  it("refuses unauthenticated, stranger, unknown-item, and out-of-range writes", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");

    const anonymous = await app.handle("POST", `/api/teams/${teamId}/lessons/current/answers`, {
      headers: sameOrigin,
      body: { participantId: casey, quizId: first.id, answer: 0 },
    });
    expect(anonymous.status).toBe(401);

    const strangerCookie = await signIn(app, "second-adult");
    const stranger = await answer(app, strangerCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: 0,
    });
    expect(stranger.status).toBe(404);
    expect(json(stranger)).toEqual({ error: "team not found" });

    const unknownItem = await answer(app, ownerCookie, teamId, {
      participantId: casey,
      quizId: "not-in-this-lesson",
      answer: 0,
    });
    expect(unknownItem.status).toBe(404);

    const outOfRange = await answer(app, ownerCookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.choices.length,
    });
    expect(outOfRange.status).toBe(400);

    await expect(
      answer(app, ownerCookie, teamId, {
        participantId: casey,
        quizId: first.id,
        answer: 0,
        note: "Casey loved it",
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
  });
});

describe("lesson of the week card on /app", () => {
  it("renders the card with poster, duration, watch link, quiz, and coach count but no feedback or answer key", async () => {
    const { app } = flagOn;
    const cookie = await signIn(app);
    await seedTeam(app, cookie);
    const lesson = currentLesson();

    const page = await app.handle("GET", "/app", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await pageText(page);
    expect(html).toContain("Lesson of the week");
    expect(html).toContain(lesson.title);
    expect(html).toContain(lesson.posterUrl);
    expect(html).toContain(formatLessonDuration(lesson.durationSeconds));
    expect(html).toContain(`href="${lesson.pageUrl}"`);
    expect(html).toContain("Watch");
    for (const item of lesson.quiz) {
      expect(html).toContain(item.prompt);
      expect(html).not.toContain(item.feedback.correct);
      expect(html).not.toContain(item.feedback.wrong);
    }
    expect(html).toContain("0 players finished this lesson");
    expect(html).not.toContain("LessonAnswers");
  });

  it("gives a managing guardian the answer island with the stored feedback line", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    const lesson = currentLesson();
    const [first, second] = lesson.quiz;
    if (casey === undefined || first === undefined || second === undefined) {
      throw new Error("Seed data is missing.");
    }
    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const wrongChoice = first.answer === 0 ? 1 : 0;
    expect(
      (
        await answer(app, guardianCookie, teamId, {
          participantId: casey,
          quizId: first.id,
          answer: wrongChoice,
        })
      ).status,
    ).toBe(200);

    const html = await pageText(
      await app.handle("GET", "/app", { headers: { cookie: guardianCookie } }),
    );
    expect(html).toContain("Lesson of the week");
    expect(html).toContain(first.feedback.wrong);
    expect(html).not.toContain(first.feedback.correct);
    expect(html).not.toContain(second.feedback.correct);
    expect(html).not.toContain(second.feedback.wrong);
    expect(html).toContain("LessonAnswers");
    expect(html).not.toContain("players finished this lesson");
  });

  it("hides the card and the lesson API when the flag is off", async () => {
    const { app } = flagOff;
    const cookie = await signIn(app);
    const { teamId } = await seedTeam(app, cookie);

    const page = await app.handle("GET", "/app", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await pageText(page);
    expect(html).toContain("Coach Pitch Comets");
    expect(html).not.toContain("Lesson of the week");
    expect(html).not.toContain("dimasciobaseball");

    const read = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie },
    });
    expect(read.status).toBe(404);
    expect(await pageText(read)).not.toContain("blooper");
  });
});

function setSeasonBand(app: App, cookie: string, teamId: string, seasonId: string, body: unknown) {
  return app.handle("PUT", `/api/teams/${teamId}/seasons/${seasonId}/lesson-age-band`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

async function currentSlug(app: App, cookie: string, teamId: string): Promise<string> {
  const read = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
    headers: { cookie },
  });
  expect(read.status).toBe(200);
  return (json(read) as { lesson: { slug: string } }).lesson.slug;
}

async function storedBand(target: LessonTestApplication, seasonId: string) {
  const rows = (await target.sql
    .prepare("SELECT lesson_age_band FROM seasons WHERE id = ?")
    .all([seasonId])) as { lesson_age_band: string | null }[];
  return rows[0]?.lesson_age_band ?? null;
}

describe("season lesson age band", () => {
  it("stores a band on the season, reads it back, and selects lessons for it", async () => {
    const { app, db } = flagOn;
    const cookie = await signIn(app);
    const { teamId, seasonId } = await seedTeam(app, cookie);

    const season = await db.transaction((tx) =>
      writeSeasonLessonAgeBand(tx, seasonId, { min: 8, max: 12 }, clock),
    );
    expect(season).toMatchObject({ id: seasonId, lessonAgeBand: { min: 8, max: 12 } });
    expect(JSON.parse((await storedBand(flagOn, seasonId)) ?? "null")).toEqual({ min: 8, max: 12 });

    const team = await app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
    expect(json(team)).toMatchObject({
      seasons: [{ id: seasonId, lessonAgeBand: { min: 8, max: 12 } }],
    });
    const directory = await app.handle("GET", "/api/teams", { headers: { cookie } });
    expect(json(directory)).toMatchObject({
      teams: [{ seasons: [{ id: seasonId, lessonAgeBand: { min: 8, max: 12 } }] }],
    });

    for (let week = 0; week < 3; week += 1) {
      now = MONDAY_2026_10_26_NOON_UTC + week * 7 * DAY_MS;
      expect(await currentSlug(app, await signIn(app), teamId)).toBe("its-ok-to-strike-out");
    }
  });

  it("falls back to the 5-7 pilot band when the season has no band or the band is cleared", async () => {
    const { app, db, sql } = flagOn;
    const cookie = await signIn(app);
    const { teamId, seasonId } = await seedTeam(app, cookie);
    const team = await app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
    expect((json(team) as { seasons: object[] }).seasons[0]).not.toHaveProperty("lessonAgeBand");

    const pilotPicks: string[] = [];
    for (let week = 1; week >= 0; week -= 1) {
      now = MONDAY_2026_10_26_NOON_UTC + week * 7 * DAY_MS;
      pilotPicks.push(currentLesson().slug);
      expect(await currentSlug(app, await signIn(app), teamId)).toBe(currentLesson().slug);
    }
    expect(new Set(pilotPicks)).toEqual(new Set(["its-ok-to-strike-out", "run-to-first"]));

    await db.transaction((tx) =>
      writeSeasonLessonAgeBand(tx, seasonId, { min: 8, max: 12 }, clock),
    );
    const cleared = await db.transaction((tx) =>
      writeSeasonLessonAgeBand(tx, seasonId, null, clock),
    );
    expect(cleared).not.toHaveProperty("lessonAgeBand");
    expect(await storedBand(flagOn, seasonId)).toBeNull();
    expect(await currentSlug(app, cookie, teamId)).toBe(currentLesson().slug);

    await sql
      .prepare("UPDATE seasons SET lesson_age_band = ? WHERE id = ?")
      .run(["{not json", seasonId]);
    expect(await currentSlug(app, cookie, teamId)).toBe(currentLesson().slug);
  });

  it("lets only the team owner set the season band", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, seasonId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    if (casey === undefined) throw new Error("Seed data is missing.");
    const body = { lessonAgeBand: { min: 8, max: 12 } };

    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const guardian = await setSeasonBand(app, guardianCookie, teamId, seasonId, body);
    expect(guardian.status).toBe(403);
    expect(json(guardian)).toEqual({ error: "team owner permission required" });
    expect(await storedBand(flagOn, seasonId)).toBeNull();

    const owner = await setSeasonBand(app, ownerCookie, teamId, seasonId, body);
    expect(owner.status).toBe(200);
    expect(JSON.parse((await storedBand(flagOn, seasonId)) ?? "null")).toEqual({ min: 8, max: 12 });

    const anonymous = await app.handle(
      "PUT",
      `/api/teams/${teamId}/seasons/${seasonId}/lesson-age-band`,
      { headers: sameOrigin, body },
    );
    expect(anonymous.status).toBe(401);

    const unknownSeason = await setSeasonBand(app, ownerCookie, teamId, "season_missing", body);
    expect(unknownSeason.status).toBe(404);
    expect(json(unknownSeason)).toEqual({ error: "season not found" });

    await expect(
      setSeasonBand(app, ownerCookie, teamId, seasonId, { lessonAgeBand: { min: 9, max: 6 } }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });

    expect(JSON.parse((await storedBand(flagOn, seasonId)) ?? "null")).toEqual({ min: 8, max: 12 });
  });

  it("refuses a stranger with the same 404 a missing team gets", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, seasonId } = await seedTeam(app, ownerCookie);
    const strangerCookie = await signIn(app, "second-adult");
    const stranger = await setSeasonBand(app, strangerCookie, teamId, seasonId, {
      lessonAgeBand: null,
    });
    expect(stranger.status).toBe(404);
    expect(json(stranger)).toEqual({ error: "team not found" });
  });
});

describe("lesson review follow-ups", () => {
  it("falls back to UTC when the season time zone is invalid instead of failing", async () => {
    const { app, sql } = flagOn;
    const cookie = await signIn(app);
    const { teamId, seasonId } = await seedTeam(app, cookie);
    await sql
      .prepare("UPDATE seasons SET time_zone = ? WHERE id = ?")
      .run(["Mars/Olympus", seasonId]);
    now = Date.UTC(2026, 10, 2, 7, 30);
    const utcPick = selectLessonOfTheWeek(vendoredLessons, PILOT_AGE_BAND, now, "UTC");
    const losAngelesPick = selectLessonOfTheWeek(
      vendoredLessons,
      PILOT_AGE_BAND,
      now,
      TEAM_TIME_ZONE,
    );
    expect(utcPick?.slug).not.toBe(losAngelesPick?.slug);

    const freshCookie = await signIn(app);
    expect(await currentSlug(app, freshCookie, teamId)).toBe(utcPick?.slug);
    const page = await app.handle("GET", "/app", { headers: { cookie: freshCookie } });
    expect(page.status).toBe(200);
    expect(await pageText(page)).toContain("Lesson of the week");
  });

  it("treats a double tap as one upsert and answers 200 every time", async () => {
    const { app, sql } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const cookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const body = { participantId: casey, quizId: first.id, answer: first.answer };

    const taps = await Promise.all([
      answer(app, cookie, teamId, body),
      answer(app, cookie, teamId, body),
      answer(app, cookie, teamId, body),
    ]);
    expect(taps.map((tap) => tap.status)).toEqual([200, 200, 200]);
    for (const tap of taps) {
      expect(json(tap)).toMatchObject({
        answer: { outcome: "correct" },
        feedback: first.feedback.correct,
      });
    }
    const rows = (await sql
      .prepare("SELECT id FROM lesson_answers WHERE participant_id = ?")
      .all([casey])) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("upserts on the unique key when two writes for one quiz item interleave", async () => {
    const { app, db, sql } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const cookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const session = await app.handle("GET", "/api/session", { headers: { cookie } });
    const personId = (json(session) as { person: { id: string } }).person.id;
    const interleaving: Db = { ...db, transaction: (fn) => fn(interleaving) };
    const services = lessonServices(interleaving, clock, {
      catalog: staticLessonCatalog(vendoredLessons),
    });
    const input = { participantId: casey, quizId: first.id, answer: first.answer };

    const outcomes = await Promise.all([
      recordLessonAnswer(services, personId, teamId, input),
      recordLessonAnswer(services, personId, teamId, input),
    ]);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    const rows = (await sql
      .prepare("SELECT id FROM lesson_answers WHERE participant_id = ?")
      .all([casey])) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("does not send the quiz answer key in the read model and returns feedback for stored answers", async () => {
    const { app } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || first === undefined) throw new Error("Seed data is missing.");
    const cookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);

    const before = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie },
    });
    const beforeView = json(before) as { lesson: { quiz: Record<string, unknown>[] } };
    expect(beforeView.lesson.quiz.length).toBeGreaterThan(0);
    for (const item of beforeView.lesson.quiz) expect(item).not.toHaveProperty("answer");

    await answer(app, cookie, teamId, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    const after = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie },
    });
    const afterView = json(after) as {
      lesson: { quiz: Record<string, unknown>[] };
      progress: { participantId: string; answers: { quizId: string; feedback: string }[] }[];
    };
    for (const item of afterView.lesson.quiz) expect(item).not.toHaveProperty("answer");
    expect(afterView.progress).toEqual([
      {
        participantId: casey,
        answers: [expect.objectContaining({ quizId: first.id, feedback: first.feedback.correct })],
      },
    ]);
    const coach = await app.handle("GET", `/api/teams/${teamId}/lessons/current`, {
      headers: { cookie: ownerCookie },
    });
    expect(json(coach)).toMatchObject({ progress: [], completedParticipants: 0 });
  });

  it("caches a catalog failure for 60 seconds and shares one in-flight load", async () => {
    let catalogRequests = 0;
    const releases: (() => void)[] = [];
    const catalog = reelLessonCatalog({
      clock,
      fetchJson: async (url) => {
        if (url.endsWith("episodes.json")) catalogRequests += 1;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        throw new Error("Reel is down.");
      },
    });

    const concurrent = Promise.all([catalog.load(), catalog.load(), catalog.load()]);
    await Promise.resolve();
    for (const release of releases.splice(0)) release();
    expect(await concurrent).toEqual([[], [], []]);
    expect(catalogRequests).toBe(1);

    now += CATALOG_FAILURE_TTL_MS - 1;
    expect(await catalog.load()).toEqual([]);
    expect(catalogRequests).toBe(1);

    now += 2;
    const retry = catalog.load();
    await Promise.resolve();
    for (const release of releases.splice(0)) release();
    await retry;
    expect(catalogRequests).toBe(2);
  });

  it("keeps serving the last good catalog while a failure is cached", async () => {
    let healthy = true;
    let catalogRequests = 0;
    const responses = new Map<string, unknown>([
      ["https://learn.dimasciobaseball.com/episodes.json", vendored("catalog.json")],
      [
        "https://media.dimasciobaseball.com/episodes/its-ok-to-strike-out/v1/episode.json",
        vendored("its-ok-to-strike-out.v1.episode.json"),
      ],
      [
        "https://media.dimasciobaseball.com/episodes/run-to-first/v1/episode.json",
        vendored("run-to-first.v1.episode.json"),
      ],
    ]);
    const catalog = reelLessonCatalog({
      clock,
      fetchJson: (url) => {
        if (url.endsWith("episodes.json")) catalogRequests += 1;
        if (!healthy) return Promise.reject(new Error("Reel is down."));
        return Promise.resolve(responses.get(url));
      },
    });
    expect(await catalog.load()).toHaveLength(2);
    healthy = false;
    now += 6 * 60 * 1_000;
    expect(await catalog.load()).toHaveLength(2);
    expect(await catalog.load()).toHaveLength(2);
    expect(catalogRequests).toBe(2);
  });
});

describe("lesson answer island", () => {
  const quiz = [
    { id: "after-a-strikeout", prompt: "What do you do next?", choices: ["Pout", "Try again"] },
    { id: "eyes-on-the-ball", prompt: "Where do your eyes go?", choices: ["Ball", "Sky"] },
  ];
  const players = [{ participantId: "participant_casey", label: "Casey Kid" }];

  it("posts ids only and shows the feedback line the server returned", async () => {
    const posted: { url: string; body: unknown }[] = [];
    const result = await submitLessonAnswer(
      "team_comets",
      "participant_casey",
      "after-a-strikeout",
      1,
      (url, body) => {
        posted.push({ url, body });
        return Promise.resolve({
          ok: true,
          json: {
            answer: {
              participantId: "participant_casey",
              quizId: "after-a-strikeout",
              answer: 1,
              outcome: "correct",
            },
            feedback: "Yes! Shake it off and swing again.",
          },
        });
      },
    );
    expect(posted).toEqual([
      {
        url: "/api/teams/team_comets/lessons/current/answers",
        body: { participantId: "participant_casey", quizId: "after-a-strikeout", answer: 1 },
      },
    ]);
    if (result === undefined) throw new Error("The answer must save.");
    const answers = mergeLessonAnswer([], result);
    const props = { answers, players, quiz, teamId: "team_comets" };

    const html = renderToStaticMarkup(createElement(LessonAnswers, props));
    expect(html).toContain("Answering for Casey Kid");
    expect(html).toContain("Yes! Shake it off and swing again.");
    expect(html).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(createElement(LessonAnswersShell, props))).toContain(
      "Yes! Shake it off and swing again.",
    );
  });

  it("returns nothing for a refused write and replaces an earlier answer for the same item", async () => {
    expect(
      await submitLessonAnswer("team_comets", "participant_rowan", "after-a-strikeout", 0, () =>
        Promise.resolve({ ok: false, json: undefined }),
      ),
    ).toBeUndefined();
    const wrong = {
      participantId: "participant_casey",
      quizId: "after-a-strikeout",
      answer: 0,
      outcome: "try_again" as const,
      feedback: "Not quite.",
    };
    const right = { ...wrong, answer: 1, outcome: "correct" as const, feedback: "Yes!" };
    expect(mergeLessonAnswer([wrong], right)).toEqual([right]);
    const html = renderToStaticMarkup(
      createElement(LessonAnswers, { answers: [right], players, quiz, teamId: "team_comets" }),
    );
    expect(html).toContain("Yes!");
    expect(html).not.toContain("Not quite.");
  });

  it("refuses a guardian writing for a profile they do not manage", async () => {
    const { app, sql } = flagOn;
    const ownerCookie = await signIn(app);
    const { teamId, participantIds } = await seedTeam(app, ownerCookie);
    const [casey, rowan] = participantIds;
    const [first] = currentLesson().quiz;
    if (casey === undefined || rowan === undefined || first === undefined) {
      throw new Error("Seed data is missing.");
    }
    const guardianCookie = await joinAsSecondAdult(app, ownerCookie, teamId, casey);
    const refused = await answer(app, guardianCookie, teamId, {
      participantId: rowan,
      quizId: first.id,
      answer: first.answer,
    });
    expect(refused.status).toBe(404);
    expect(json(refused)).toEqual({ error: "participant not found" });
    const rows = (await sql.prepare("SELECT id FROM lesson_answers").all([])) as unknown[];
    expect(rows).toHaveLength(0);
  });
});
