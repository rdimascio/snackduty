import type { Lesson } from "@snackday/domain";

import type { Clock } from "../lib/server/application-contracts";
import { parseReelCatalog, parseReelEpisode } from "./reel-contract";
import type { ReelQuizSkills } from "./reel-contract";

export const REEL_CATALOG_URL = "https://learn.dimasciobaseball.com/episodes.json";
const CATALOG_TTL_MS = 5 * 60 * 1_000;
export const CATALOG_FAILURE_TTL_MS = 60 * 1_000;
const FETCH_TIMEOUT_MS = 5_000;

type LessonKey = Pick<Lesson, "seriesId" | "slug">;

export interface LessonCatalog {
  load(): Promise<readonly Lesson[]>;
  reelSkill(lesson: LessonKey, quizId: string): string | undefined;
}

export interface CatalogEpisode {
  readonly lesson: Lesson;
  readonly quizSkills?: ReelQuizSkills;
}

export type JsonFetcher = (url: string) => Promise<unknown>;

function episodeKey(lesson: LessonKey): string {
  return `${lesson.seriesId}/${lesson.slug}`;
}

function quizSkillLookup() {
  const byEpisode = new Map<string, ReelQuizSkills>();
  return {
    remember(lesson: LessonKey, quizSkills: ReelQuizSkills) {
      byEpisode.set(episodeKey(lesson), quizSkills);
    },
    reelSkill(lesson: LessonKey, quizId: string): string | undefined {
      const quizSkills = byEpisode.get(episodeKey(lesson));
      return quizSkills !== undefined && Object.hasOwn(quizSkills, quizId)
        ? quizSkills[quizId]
        : undefined;
    },
  };
}

export function staticLessonCatalog(entries: readonly (Lesson | CatalogEpisode)[]): LessonCatalog {
  const skills = quizSkillLookup();
  const lessons = entries.map((entry) => {
    if (!("lesson" in entry)) return entry;
    if (entry.quizSkills !== undefined) skills.remember(entry.lesson, entry.quizSkills);
    return entry.lesson;
  });
  return { load: () => Promise.resolve(lessons), reelSkill: skills.reelSkill };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Reel request failed with HTTP ${response.status}.`);
  return response.json();
}

function logCatalogIssue(event: string, url: string): void {
  console.warn(JSON.stringify({ level: "warn", event, url }));
}

export function reelLessonCatalog(options: {
  readonly clock: Clock;
  readonly catalogUrl?: string;
  readonly fetchJson?: JsonFetcher;
}): LessonCatalog {
  const catalogUrl = options.catalogUrl ?? REEL_CATALOG_URL;
  const fetcher = options.fetchJson ?? fetchJson;
  const manifests = new Map<string, Lesson>();
  const skills = quizSkillLookup();
  let cached: { readonly lessons: readonly Lesson[]; readonly expiresAt: number } | undefined;

  async function manifest(url: string): Promise<Lesson | undefined> {
    const known = manifests.get(url);
    if (known !== undefined) return known;
    try {
      const parsed = parseReelEpisode(await fetcher(url));
      if (!parsed.ok) {
        logCatalogIssue(`lessons.manifest_${parsed.reason}`, url);
        return undefined;
      }
      manifests.set(url, parsed.value);
      skills.remember(parsed.value, parsed.quizSkills);
      return parsed.value;
    } catch {
      logCatalogIssue("lessons.manifest_unavailable", url);
      return undefined;
    }
  }

  let inFlight: Promise<readonly Lesson[]> | undefined;

  function failed(event: string, now: number): readonly Lesson[] {
    logCatalogIssue(event, catalogUrl);
    const lessons = cached?.lessons ?? [];
    cached = { lessons, expiresAt: now + CATALOG_FAILURE_TTL_MS };
    return lessons;
  }

  async function refresh(now: number): Promise<readonly Lesson[]> {
    let catalog;
    try {
      catalog = parseReelCatalog(await fetcher(catalogUrl));
    } catch {
      return failed("lessons.catalog_unavailable", now);
    }
    if (!catalog.ok) return failed(`lessons.catalog_${catalog.reason}`, now);
    const loaded = await Promise.all(catalog.value.map((url) => manifest(url)));
    const lessons = loaded.filter((lesson): lesson is Lesson => lesson !== undefined);
    cached = { lessons, expiresAt: now + CATALOG_TTL_MS };
    return lessons;
  }

  return {
    reelSkill: skills.reelSkill,
    load() {
      const now = options.clock();
      if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.lessons);
      inFlight ??= refresh(now).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
