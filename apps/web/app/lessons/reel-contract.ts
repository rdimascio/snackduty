import { lessonSchema, REEL_CATALOG_CONTRACT, REEL_EPISODE_CONTRACT } from "@snackday/domain";
import type { Lesson } from "@snackday/domain";
import { z } from "zod";

const httpsUrlSchema = z.url({ protocol: /^https$/ });
const kebabIdSchema = z.string().regex(/^[a-z0-9-]+$/);

const reelQuizItemSchema = z.object({
  id: kebabIdSchema,
  prompt: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2).max(4),
  answer: z.number().int().min(0),
  feedback: z.object({ correct: z.string().min(1), wrong: z.string().min(1) }),
  skill: kebabIdSchema,
});

const reelEpisodeSchema = z
  .object({
    schema: z.literal(REEL_EPISODE_CONTRACT),
    series: z.object({ id: kebabIdSchema, title: z.string().min(1), site: httpsUrlSchema }),
    episode: z.object({
      slug: kebabIdSchema,
      number: z.number().int().min(1),
      title: z.string().min(1),
      blurb: z.string(),
      ages: z.object({ min: z.number().int().min(2), max: z.number().int().max(18) }),
      version: z.string().regex(/^v\d+$/),
      page: httpsUrlSchema,
    }),
    media: z.object({
      video: httpsUrlSchema,
      poster: httpsUrlSchema,
      captions: z
        .array(z.object({ lang: z.string(), label: z.string(), url: httpsUrlSchema }))
        .min(1),
      seconds: z.number().positive(),
    }),
    skills: z.array(kebabIdSchema).min(1),
    quiz: z.array(reelQuizItemSchema).min(1).max(3),
    transcript: z.array(z.object({ who: z.string(), text: z.string() })).min(1),
    publishedAt: z.iso.datetime(),
  })
  .superRefine((manifest, issues) => {
    const quizIds = new Set<string>();
    manifest.quiz.forEach((item, index) => {
      if (item.answer >= item.choices.length) {
        issues.addIssue({
          code: "custom",
          path: ["quiz", index, "answer"],
          message: "answer out of range",
        });
      }
      if (!manifest.skills.includes(item.skill)) {
        issues.addIssue({
          code: "custom",
          path: ["quiz", index, "skill"],
          message: "unknown skill",
        });
      }
      if (quizIds.has(item.id)) {
        issues.addIssue({
          code: "custom",
          path: ["quiz", index, "id"],
          message: "duplicate quiz id",
        });
      }
      quizIds.add(item.id);
    });
  });

const reelCatalogSchema = z.object({
  schema: z.literal(REEL_CATALOG_CONTRACT),
  episodes: z.array(
    z.object({
      slug: kebabIdSchema,
      number: z.number().int().min(1),
      title: z.string(),
      manifest: httpsUrlSchema,
    }),
  ),
});

export type ReelParseFailure = {
  readonly ok: false;
  readonly reason: "wrong_contract" | "invalid";
};

export type ReelParseResult<T> = { readonly ok: true; readonly value: T } | ReelParseFailure;

export type ReelQuizSkills = Readonly<Record<string, string>>;

export type ReelEpisodeResult =
  | { readonly ok: true; readonly value: Lesson; readonly quizSkills: ReelQuizSkills }
  | ReelParseFailure;

function contractOf(input: unknown): unknown {
  return typeof input === "object" && input !== null && "schema" in input
    ? (input as { schema: unknown }).schema
    : undefined;
}

export function parseReelEpisode(input: unknown): ReelEpisodeResult {
  if (contractOf(input) !== REEL_EPISODE_CONTRACT) return { ok: false, reason: "wrong_contract" };
  const parsed = reelEpisodeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { series, episode, media, quiz } = parsed.data;
  const lesson = lessonSchema.safeParse({
    seriesId: series.id,
    seriesTitle: series.title,
    slug: episode.slug,
    number: episode.number,
    title: episode.title,
    ages: { min: episode.ages.min, max: episode.ages.max },
    pageUrl: episode.page,
    posterUrl: media.poster,
    durationSeconds: media.seconds,
    quiz: quiz.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      choices: item.choices,
      answer: item.answer,
      feedback: { correct: item.feedback.correct, wrong: item.feedback.wrong },
    })),
  });
  if (!lesson.success) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    value: lesson.data,
    quizSkills: Object.fromEntries(quiz.map((item) => [item.id, item.skill])),
  };
}

export function parseReelCatalog(input: unknown): ReelParseResult<readonly string[]> {
  if (contractOf(input) !== REEL_CATALOG_CONTRACT) return { ok: false, reason: "wrong_contract" };
  const parsed = reelCatalogSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data.episodes.map((entry) => entry.manifest) }
    : { ok: false, reason: "invalid" };
}
