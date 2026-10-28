import { fileURLToPath } from "node:url";

import { REEL_CATALOG_URL } from "../../apps/web/app/lessons/catalog";
import { REEL_MEDIA_ORIGIN } from "../../apps/web/app/server/content-security-policy";
import { REEL_CATALOG_CONTRACT, REEL_EPISODE_CONTRACT } from "../../packages/domain/src/lessons";

const LEARN_ORIGIN = new URL(REEL_CATALOG_URL).origin;

export const FIXTURE_MANIFEST_URL = `${LEARN_ORIGIN}/e2e/fixture-episode.json`;
export const FIXTURE_POSTER_URL = `${REEL_MEDIA_ORIGIN}/e2e/fixture-poster.png`;
export const FIXTURE_POSTER_FILE = fileURLToPath(
  new URL("./fixtures/lesson-poster.png", import.meta.url),
);

export const FIXTURE_LESSON = {
  seriesId: "e2e-fixture-series",
  slug: "e2e-ready-position",
  quizId: "e2e-ready-check",
  correctAnswer: 1,
} as const;

const FIXTURE_EPISODE = {
  schema: REEL_EPISODE_CONTRACT,
  series: {
    id: FIXTURE_LESSON.seriesId,
    title: "E2E Fixture Series",
    site: `${LEARN_ORIGIN}/e2e/`,
  },
  episode: {
    slug: FIXTURE_LESSON.slug,
    number: 1,
    title: "E2E Ready Position",
    blurb: "A deterministic lesson for the browser suite.",
    ages: { min: 2, max: 18 },
    version: "v1",
    page: `${LEARN_ORIGIN}/e2e/ready-position/`,
  },
  media: {
    video: `${REEL_MEDIA_ORIGIN}/e2e/fixture-video.mp4`,
    poster: FIXTURE_POSTER_URL,
    captions: [{ lang: "en", label: "English", url: `${REEL_MEDIA_ORIGIN}/e2e/fixture.vtt` }],
    seconds: 60,
  },
  skills: ["ready-position", "watch-the-ball"],
  quiz: [
    {
      id: FIXTURE_LESSON.quizId,
      prompt: "Where are your hands in ready position?",
      choices: ["On your hips", "Out in front, glove open"],
      answer: FIXTURE_LESSON.correctAnswer,
      feedback: { correct: "Yes, glove open and ready.", wrong: "Try again: hands out front." },
      skill: "ready-position",
    },
    {
      id: "e2e-eyes-check",
      prompt: "What do you watch as the pitch comes in?",
      choices: ["The ball", "The crowd"],
      answer: 0,
      feedback: { correct: "Yes, eyes on the ball.", wrong: "Try again: watch the ball." },
      skill: "watch-the-ball",
    },
  ],
  transcript: [{ who: "Coach", text: "Get in ready position and watch the ball." }],
  publishedAt: "2026-01-05T00:00:00.000Z",
} as const;

const FIXTURE_CATALOG = {
  schema: REEL_CATALOG_CONTRACT,
  episodes: [
    {
      slug: FIXTURE_EPISODE.episode.slug,
      number: FIXTURE_EPISODE.episode.number,
      title: FIXTURE_EPISODE.episode.title,
      manifest: FIXTURE_MANIFEST_URL,
    },
  ],
} as const;

export const FIXTURE_JSON: Readonly<Record<string, unknown>> = {
  [REEL_CATALOG_URL]: FIXTURE_CATALOG,
  [FIXTURE_MANIFEST_URL]: FIXTURE_EPISODE,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopback(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}
