import { z } from "zod";

export const REEL_EPISODE_CONTRACT = "reel.episode/v0";
export const REEL_CATALOG_CONTRACT = "reel.catalog/v0";

const kebabIdSchema = z.string().regex(/^[a-z0-9-]+$/);

export const ageBandSchema = z
  .strictObject({
    min: z.number().int().min(0).max(18),
    max: z.number().int().min(0).max(18),
  })
  .refine((band) => band.min <= band.max, { message: "Age band min must not exceed max" });
export type AgeBand = z.infer<typeof ageBandSchema>;

export const PILOT_AGE_BAND: AgeBand = { min: 5, max: 7 };

export function resolveLessonAgeBand(seasonBand: AgeBand | undefined): AgeBand {
  return seasonBand ?? PILOT_AGE_BAND;
}

export const seasonLessonAgeBandInputSchema = z.strictObject({
  lessonAgeBand: ageBandSchema.nullable(),
});
export type SeasonLessonAgeBandInput = z.infer<typeof seasonLessonAgeBandInputSchema>;

export const lessonQuizItemSchema = z.strictObject({
  id: kebabIdSchema,
  prompt: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2).max(4),
  answer: z.number().int().min(0),
  feedback: z.strictObject({ correct: z.string().min(1), wrong: z.string().min(1) }),
});
export type LessonQuizItem = z.infer<typeof lessonQuizItemSchema>;

export const lessonSchema = z.strictObject({
  seriesId: kebabIdSchema,
  seriesTitle: z.string().min(1),
  slug: kebabIdSchema,
  number: z.number().int().min(1),
  title: z.string().min(1),
  ages: ageBandSchema,
  pageUrl: z.url({ protocol: /^https$/ }),
  posterUrl: z.url({ protocol: /^https$/ }),
  durationSeconds: z.number().positive(),
  quiz: z.array(lessonQuizItemSchema).min(1).max(3),
});
export type Lesson = z.infer<typeof lessonSchema>;

export type PublicLessonQuizItem = Omit<LessonQuizItem, "answer">;
export type PublicLesson = Omit<Lesson, "quiz"> & {
  readonly quiz: readonly PublicLessonQuizItem[];
};

export function publicLesson(lesson: Lesson): PublicLesson {
  return {
    ...lesson,
    quiz: lesson.quiz.map(({ answer: _answer, ...item }) => item),
  };
}

export const lessonOutcomeSchema = z.enum(["correct", "try_again"]);
export type LessonOutcome = z.infer<typeof lessonOutcomeSchema>;

export const lessonAnswerInputSchema = z.strictObject({
  participantId: z.string().trim().min(1),
  quizId: kebabIdSchema,
  answer: z.number().int().min(0).max(3),
});
export type LessonAnswerInput = z.infer<typeof lessonAnswerInputSchema>;

export const lessonAnswerRecordSchema = z.strictObject({
  participantId: z.string().min(1),
  seriesId: kebabIdSchema,
  episodeSlug: kebabIdSchema,
  quizId: kebabIdSchema,
  answer: z.number().int().min(0),
  outcome: lessonOutcomeSchema,
  answeredAt: z.iso.datetime(),
});
export type LessonAnswerRecord = z.infer<typeof lessonAnswerRecordSchema>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const FIRST_ISO_MONDAY_UTC_MS = Date.UTC(1970, 0, 5);

function localCalendarDayUtcMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: "year" | "month" | "day") =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

export function isoWeekIndex(instantMs: number, timeZone = "UTC"): number {
  return Math.floor(
    (localCalendarDayUtcMs(instantMs, timeZone) - FIRST_ISO_MONDAY_UTC_MS) / WEEK_MS,
  );
}

export function lessonFitsAgeBand(lesson: Pick<Lesson, "ages">, band: AgeBand): boolean {
  return lesson.ages.min <= band.min && lesson.ages.max >= band.max;
}

export function selectLessonOfTheWeek(
  lessons: readonly Lesson[],
  band: AgeBand,
  instantMs: number,
  timeZone = "UTC",
): Lesson | undefined {
  const eligible = lessons
    .filter((lesson) => lessonFitsAgeBand(lesson, band))
    .toSorted(
      (left, right) =>
        left.seriesId.localeCompare(right.seriesId) ||
        left.number - right.number ||
        left.slug.localeCompare(right.slug),
    );
  if (eligible.length === 0) return undefined;
  const week = isoWeekIndex(instantMs, timeZone);
  return eligible[((week % eligible.length) + eligible.length) % eligible.length];
}

export function lessonOutcomeFor(item: LessonQuizItem, answer: number): LessonOutcome {
  return item.answer === answer ? "correct" : "try_again";
}

export function lessonCompleted(
  lesson: Pick<Lesson, "quiz">,
  answers: readonly Pick<LessonAnswerRecord, "quizId" | "outcome">[],
): boolean {
  const correct = new Set(
    answers.filter((answer) => answer.outcome === "correct").map((answer) => answer.quizId),
  );
  return lesson.quiz.every((item) => correct.has(item.id));
}
