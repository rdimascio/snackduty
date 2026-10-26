import type { Lesson } from "@snackday/domain";

import type { Clock } from "../lib/server/application-contracts";
import { parseReelCatalog, parseReelEpisode } from "./reel-contract";

export const REEL_CATALOG_URL = "https://learn.dimasciobaseball.com/episodes.json";
const CATALOG_TTL_MS = 5 * 60 * 1_000;
export const CATALOG_FAILURE_TTL_MS = 60 * 1_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface LessonCatalog {
  load(): Promise<readonly Lesson[]>;
}

export type JsonFetcher = (url: string) => Promise<unknown>;

export function staticLessonCatalog(lessons: readonly Lesson[]): LessonCatalog {
  return { load: () => Promise.resolve(lessons) };
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
