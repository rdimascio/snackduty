import type { AnyLestoResponse } from "@lesto/web";

import { articlePath, COACH_ARTICLES_PATH } from "./articles";
import type { CoachArticleLibrary } from "./articles";
import { COACH_BOOK_PATH, COACH_ORIGIN } from "./content";

export const COACH_SITEMAP_PATH = "/sitemap.xml";

export const COACH_ROBOTS_PATH = "/robots.txt";

const HOME_PATH = "/";

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const XML_SPECIAL = /[&<>"']/gu;

const SEO_CACHE_CONTROL = "public, max-age=3600";

function xmlText(value: string): string {
  return value.replace(XML_SPECIAL, (character) => XML_ESCAPES[character] ?? character);
}

interface SitemapEntry {
  readonly path: string;
  readonly lastModified?: string;
}

function sitemapEntries(library: CoachArticleLibrary, bookingOpen: boolean): SitemapEntry[] {
  return [
    { path: HOME_PATH },
    ...(bookingOpen ? [{ path: COACH_BOOK_PATH }] : []),
    { path: COACH_ARTICLES_PATH },
    ...library.articles.map((article) => ({
      path: articlePath(article),
      lastModified: article.published,
    })),
  ];
}

function urlElement({ path, lastModified }: SitemapEntry): string {
  const location = `<loc>${xmlText(new URL(path, COACH_ORIGIN).href)}</loc>`;
  const modified = lastModified === undefined ? "" : `<lastmod>${xmlText(lastModified)}</lastmod>`;
  return `<url>${location}${modified}</url>`;
}

export function coachSitemapXml(library: CoachArticleLibrary, bookingOpen: boolean): string {
  const urls = sitemapEntries(library, bookingOpen)
    .map((entry) => urlElement(entry))
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function coachRobotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${new URL(COACH_SITEMAP_PATH, COACH_ORIGIN).href}\n`;
}

function textResponse(body: string, contentType: string): AnyLestoResponse {
  return {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": SEO_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    },
    body,
  };
}

export function coachSitemapResponse(
  library: CoachArticleLibrary,
  bookingOpen: boolean,
): AnyLestoResponse {
  return textResponse(coachSitemapXml(library, bookingOpen), "application/xml; charset=utf-8");
}

export function coachRobotsResponse(): AnyLestoResponse {
  return textResponse(coachRobotsTxt(), "text/plain; charset=utf-8");
}
