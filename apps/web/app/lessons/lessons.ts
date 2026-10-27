import {
  and,
  createTableSql,
  defineTable,
  dropTableSql,
  eq,
  inList,
  integer,
  text,
} from "@lesto/db";
import type { Db, InferRow } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import {
  lessonAnswerInputSchema,
  lessonAnswerRecordSchema,
  lessonCompleted,
  lessonOutcomeFor,
  lessonOutcomeSchema,
  publicLesson,
  resolveLessonAgeBand,
  selectLessonOfTheWeek,
} from "@snackday/domain";
import type {
  Lesson,
  LessonAnswerInput,
  LessonAnswerRecord,
  LessonOutcome,
  LessonQuizItem,
  PublicLesson,
} from "@snackday/domain";

import type { Clock, SessionService as Sessions } from "../lib/server/application-contracts";
import { authorizeTeamOperation } from "../lib/server/authorization";
import { isValidTimeZone } from "../lib/server/event-time";
import { authenticatedAdult, people } from "../lib/server/identity";
import { guardianRelationships, memberships, participants } from "../lib/server/roster";
import { seasonLessonAgeBand, seasons, teamAccess } from "../lib/server/teams";
import { appendCheckPassed } from "../skills/skill-events";
import type { LessonCatalog } from "./catalog";

export interface LessonProgressAnswer extends LessonAnswerRecord {
  readonly feedback: string;
}

export interface LessonProgress {
  readonly participantId: string;
  readonly answers: readonly LessonProgressAnswer[];
}

export interface LessonCardData {
  readonly teamId: string;
  readonly lesson: PublicLesson;
  readonly progress: readonly LessonProgress[];
  readonly completedParticipants?: number;
}

export const lessonAnswers = defineTable("lesson_answers", {
  id: text("id").primaryKey(),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id),
  seriesId: text("series_id").notNull(),
  episodeSlug: text("episode_slug").notNull(),
  quizId: text("quiz_id").notNull(),
  answerIndex: integer("answer_index").notNull(),
  outcome: text("outcome").notNull(),
  recordedByPersonId: text("recorded_by_person_id")
    .notNull()
    .references(() => people.id),
  answeredAt: text("answered_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const createLessonAnswers: MigrationEntry = {
  version: "014_create_lesson_answers",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(lessonAnswers, schema.dialect));
      await schema.execute(
        "CREATE UNIQUE INDEX lesson_answers_progress_key_idx ON lesson_answers (participant_id, series_id, episode_slug, quiz_id)",
      );
      await schema.execute(
        "CREATE INDEX lesson_answers_episode_idx ON lesson_answers (series_id, episode_slug)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(lessonAnswers));
    },
  },
};

export interface LessonServices {
  readonly db: Db;
  readonly clock: Clock;
  readonly catalog: LessonCatalog;
}

export interface LessonOptions {
  readonly enabled: boolean;
  readonly catalog: LessonCatalog;
}

const lessonServicesKey = "snackday.lessons";

export function bindLessonServices(context: Context, services: LessonServices): void {
  context.set(lessonServicesKey, services);
}

export function lessonServicesFrom(context: Context): LessonServices | undefined {
  return context.get<LessonServices>(lessonServicesKey);
}

export function lessonServices(
  db: Db,
  clock: Clock,
  options: Pick<LessonOptions, "catalog">,
): LessonServices {
  return { db, clock, catalog: options.catalog };
}

export async function currentSeason(tx: Db, teamId: string) {
  const rows = await tx
    .select()
    .from(seasons)
    .where(and(eq(seasons.teamId, teamId), eq(seasons.status, "active")))
    .all();
  rows.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
  );
  return rows[0];
}

export function seasonTimeZone(season: { readonly timeZone: string } | undefined): string {
  return season !== undefined && isValidTimeZone(season.timeZone) ? season.timeZone : "UTC";
}

async function currentTeamLesson(
  services: LessonServices,
  lessons: readonly Lesson[],
  tx: Db,
  teamId: string,
): Promise<{ readonly lesson: Lesson; readonly timeZone: string } | undefined> {
  const season = await currentSeason(tx, teamId);
  const timeZone = seasonTimeZone(season);
  const lesson = selectLessonOfTheWeek(
    lessons,
    resolveLessonAgeBand(season === undefined ? undefined : seasonLessonAgeBand(season)),
    services.clock(),
    timeZone,
  );
  return lesson === undefined ? undefined : { lesson, timeZone };
}

async function rosteredSeasonIds(tx: Db, teamId: string, participantId: string) {
  const participant = await tx
    .select()
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.status, "active")))
    .get();
  if (participant === undefined) return [];
  const rows = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.memberParticipantId, participant.id),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .all();
  return [...new Set(rows.map((row) => row.seasonId))];
}

async function isManagingGuardian(tx: Db, personId: string, participantId: string) {
  const rows = await tx
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.guardianPersonId, personId),
        eq(guardianRelationships.participantId, participantId),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .all();
  return rows.some((row) =>
    (JSON.parse(row.permissions) as string[]).includes("participant.manage"),
  );
}

export async function mayManageParticipant(
  tx: Db,
  personId: string,
  teamId: string,
  participantId: string,
): Promise<boolean> {
  if (!(await isManagingGuardian(tx, personId, participantId))) return false;
  for (const seasonId of await rosteredSeasonIds(tx, teamId, participantId)) {
    if (
      await authorizeTeamOperation(tx, personId, "participant.manage", {
        teamId,
        seasonId,
        participantId,
      })
    ) {
      return true;
    }
  }
  return false;
}

export const COACH_CARD_READ_PERMISSION = "roster.manage";

async function coachesRosteredParticipant(
  tx: Db,
  personId: string,
  teamId: string,
  participantId: string,
): Promise<boolean> {
  for (const seasonId of await rosteredSeasonIds(tx, teamId, participantId)) {
    if (
      await authorizeTeamOperation(tx, personId, COACH_CARD_READ_PERMISSION, {
        teamId,
        seasonId,
        participantId,
      })
    ) {
      return true;
    }
  }
  return false;
}

export async function mayReadParticipantCard(
  tx: Db,
  personId: string,
  teamId: string,
  participantId: string,
): Promise<boolean> {
  return (
    (await mayManageParticipant(tx, personId, teamId, participantId)) ||
    (await coachesRosteredParticipant(tx, personId, teamId, participantId))
  );
}

export async function teamParticipantIds(tx: Db, teamId: string): Promise<string[]> {
  const rows = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .all();
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row.memberParticipantId === null ? [] : [row.memberParticipantId])),
    ),
  ];
  if (ids.length === 0) return [];
  const active = await tx
    .select()
    .from(participants)
    .where(and(inList(participants.id, ids), eq(participants.status, "active")))
    .all();
  return active.map((row) => row.id).sort();
}

type LessonAnswerRow = InferRow<typeof lessonAnswers>;

function projectAnswer(row: LessonAnswerRow): LessonAnswerRecord {
  return lessonAnswerRecordSchema.parse({
    participantId: row.participantId,
    seriesId: row.seriesId,
    episodeSlug: row.episodeSlug,
    quizId: row.quizId,
    answer: row.answerIndex,
    outcome: lessonOutcomeSchema.parse(row.outcome),
    answeredAt: row.answeredAt,
  });
}

async function episodeAnswers(
  tx: Db,
  lesson: Lesson,
  participantIds: readonly string[],
): Promise<LessonAnswerRecord[]> {
  if (participantIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(lessonAnswers)
    .where(
      and(
        eq(lessonAnswers.seriesId, lesson.seriesId),
        eq(lessonAnswers.episodeSlug, lesson.slug),
        inList(lessonAnswers.participantId, [...participantIds]),
      ),
    )
    .all();
  return rows
    .map(projectAnswer)
    .sort(
      (left, right) =>
        left.participantId.localeCompare(right.participantId) ||
        left.quizId.localeCompare(right.quizId),
    );
}

export function countCompletedParticipants(
  lesson: Lesson,
  answers: readonly LessonAnswerRecord[],
): number {
  const byParticipant = new Map<string, LessonAnswerRecord[]>();
  for (const answer of answers) {
    byParticipant.set(answer.participantId, [
      ...(byParticipant.get(answer.participantId) ?? []),
      answer,
    ]);
  }
  return [...byParticipant.values()].filter((entries) => lessonCompleted(lesson, entries)).length;
}

function feedbackFor(item: LessonQuizItem, outcome: LessonOutcome): string {
  return outcome === "correct" ? item.feedback.correct : item.feedback.wrong;
}

function withFeedback(lesson: Lesson, answer: LessonAnswerRecord): LessonProgressAnswer[] {
  const item = lesson.quiz.find((candidate) => candidate.id === answer.quizId);
  return item === undefined ? [] : [{ ...answer, feedback: feedbackFor(item, answer.outcome) }];
}

export interface TeamLessonView {
  readonly lesson: PublicLesson;
  readonly progress: readonly LessonProgress[];
  readonly completedParticipants?: number;
}

export type LessonResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 404;
      readonly error: string;
    };

const teamNotFound = { ok: false, status: 404, error: "team not found" } as const;
const lessonNotFound = { ok: false, status: 404, error: "lesson not found" } as const;

export async function readTeamLesson(
  services: LessonServices,
  personId: string,
  teamId: string,
): Promise<LessonResult<TeamLessonView>> {
  const lessons = await services.catalog.load();
  return services.db.transaction(async (tx) => {
    const access = await teamAccess(tx, teamId, personId);
    if (access === undefined) return teamNotFound;
    const current = await currentTeamLesson(services, lessons, tx, access.team.id);
    if (current === undefined) return lessonNotFound;
    const { lesson } = current;

    const roster = await teamParticipantIds(tx, access.team.id);
    const answers = await episodeAnswers(tx, lesson, roster);
    const progress = [];
    for (const participantId of roster) {
      if (await mayManageParticipant(tx, personId, access.team.id, participantId)) {
        progress.push({
          participantId,
          answers: answers
            .filter((answer) => answer.participantId === participantId)
            .flatMap((answer) => withFeedback(lesson, answer)),
        });
      }
    }
    return {
      ok: true,
      value: {
        lesson: publicLesson(lesson),
        progress,
        ...(access.capabilities.manage
          ? { completedParticipants: countCompletedParticipants(lesson, answers) }
          : {}),
      },
    };
  });
}

const upsertLessonAnswerSql = `INSERT INTO lesson_answers (id, participant_id, series_id, episode_slug, quiz_id, answer_index, outcome, recorded_by_person_id, answered_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (participant_id, series_id, episode_slug, quiz_id) DO UPDATE SET
  answer_index = excluded.answer_index,
  outcome = excluded.outcome,
  recorded_by_person_id = excluded.recorded_by_person_id,
  answered_at = excluded.answered_at
WHERE NOT (lesson_answers.outcome = 'correct' AND excluded.outcome = 'try_again')
RETURNING id`;

export async function recordLessonAnswer(
  services: LessonServices,
  personId: string,
  teamId: string,
  input: LessonAnswerInput,
): Promise<LessonResult<{ answer: LessonAnswerRecord; feedback: string }>> {
  const lessons = await services.catalog.load();
  return services.db.transaction(async (tx) => {
    const access = await teamAccess(tx, teamId, personId);
    if (access === undefined) return teamNotFound;
    const current = await currentTeamLesson(services, lessons, tx, access.team.id);
    if (current === undefined) return lessonNotFound;
    const { lesson, timeZone } = current;
    const item = lesson.quiz.find((candidate) => candidate.id === input.quizId);
    if (item === undefined) return { ok: false, status: 404, error: "quiz item not found" };
    if (input.answer >= item.choices.length) {
      return { ok: false, status: 400, error: "answer is out of range" };
    }
    if (!(await mayManageParticipant(tx, personId, access.team.id, input.participantId))) {
      return { ok: false, status: 404, error: "participant not found" };
    }

    const outcome = lessonOutcomeFor(item, input.answer);
    const nowMs = services.clock();
    const now = new Date(nowMs).toISOString();
    const answerKey = and(
      eq(lessonAnswers.participantId, input.participantId),
      eq(lessonAnswers.seriesId, lesson.seriesId),
      eq(lessonAnswers.episodeSlug, lesson.slug),
      eq(lessonAnswers.quizId, item.id),
    );
    const previous = await tx.select().from(lessonAnswers).where(answerKey).get();
    await tx.raw(upsertLessonAnswerSql, [
      `lesson_answer_${crypto.randomUUID()}`,
      input.participantId,
      lesson.seriesId,
      lesson.slug,
      item.id,
      input.answer,
      outcome,
      personId,
      now,
      now,
    ]);
    const stored = await tx.select().from(lessonAnswers).where(answerKey).get();
    if (stored === undefined) throw new Error("Lesson answer disappeared during write.");
    if (outcome === "correct" && previous?.outcome !== "correct") {
      await appendCheckPassed(tx, {
        participantId: input.participantId,
        seriesId: lesson.seriesId,
        episodeSlug: lesson.slug,
        quizId: item.id,
        reelSkill: services.catalog.reelSkill(lesson, item.id),
        occurredAtMs: nowMs,
        timeZone,
      });
    }
    const answer = projectAnswer(stored);
    return { ok: true, value: { answer, feedback: feedbackFor(item, answer.outcome) } };
  });
}

const unauthorized = { error: "authentication required" } as const;

async function readCurrentLesson(
  c: Context<"/api/teams/:teamId/lessons/current">,
  services: LessonServices,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(services.db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);
  const outcome = await readTeamLesson(services, identity.person.id, c.param("teamId"));
  return outcome.ok ? c.json(outcome.value) : c.json({ error: outcome.error }, outcome.status);
}

async function answerCurrentLesson(
  c: Context<"/api/teams/:teamId/lessons/current/answers">,
  services: LessonServices,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(services.db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);
  const input = c.valid(lessonAnswerInputSchema);
  const outcome = await recordLessonAnswer(services, identity.person.id, c.param("teamId"), input);
  return outcome.ok ? c.json(outcome.value) : c.json({ error: outcome.error }, outcome.status);
}

export async function loadLessonCard(
  services: LessonServices,
  personId: string,
  teamId: string,
): Promise<LessonCardData | undefined> {
  try {
    const outcome = await readTeamLesson(services, personId, teamId);
    if (!outcome.ok) return undefined;
    const { lesson, progress, completedParticipants } = outcome.value;
    return completedParticipants === undefined
      ? { teamId, lesson, progress }
      : { teamId, lesson, progress, completedParticipants };
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "lessons.card_unavailable" }));
    return undefined;
  }
}

export function registerLessonRoutes(app: Lesto, sessions: Sessions, services: LessonServices) {
  return app
    .use((c, next) => {
      bindLessonServices(c, services);
      return next();
    })
    .get("/api/teams/:teamId/lessons/current", (c) => readCurrentLesson(c, services, sessions))
    .post("/api/teams/:teamId/lessons/current/answers", (c) =>
      answerCurrentLesson(c, services, sessions),
    );
}
