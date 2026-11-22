import { readdirSync, readFileSync } from "node:fs";

import type { PageDef } from "@lesto/web";
import { z } from "zod";

import { COACH_LEARN_URL } from "./content";
import { parseMarkdown } from "./markdown";
import type { MarkdownBlock } from "./markdown";

export const COACH_ARTICLES_PATH = "/articles";

export const COACH_ARTICLE_PATH = "/articles/:slug";

export const COACH_ARTICLE_PREFIX = `${COACH_ARTICLES_PATH}/`;

const ARTICLE_EXTENSION = ".md";

const DEFAULT_ARTICLE_DIRECTORY = new URL("./articles/", import.meta.url);

const DEVELOPMENT_MODE = "development";

const FRONTMATTER = /^---\n([^]*?)\n---\n([^]*)$/u;

const FRONTMATTER_LINE = /^([A-Za-z]+):\s*(.*)$/u;

const QUOTED = /^"(.*)"$/u;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const BOOLEAN_TEXT: Readonly<Record<string, boolean>> = { true: true, false: false };

const frontmatterSchema = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  slug: z.string().regex(SLUG),
  published: z.iso.date(),
  draft: z.boolean(),
  episode: z.string().regex(SLUG).optional(),
});

export interface CoachArticle {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly published: string;
  readonly draft: boolean;
  /** A Coach Blooper episode slug from the learn site's `episodes.json`. */
  readonly episode?: string;
  readonly body: readonly MarkdownBlock[];
}

export interface CoachArticleFile {
  readonly name: string;
  readonly source: string;
}

/** Drafts are visible only in development; every other mode serves published articles only. */
export type ArticleVisibility = "with-drafts" | "published-only";

export function articleVisibilityFor(mode: string): ArticleVisibility {
  return mode === DEVELOPMENT_MODE ? "with-drafts" : "published-only";
}

export class CoachArticleError extends Error {}

function frontmatterValue(raw: string): string | boolean {
  const quoted = QUOTED.exec(raw);
  if (quoted !== null) return quoted[1] ?? "";
  return BOOLEAN_TEXT[raw] ?? raw;
}

function readFrontmatter(name: string, block: string): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  for (const line of block.split("\n")) {
    const match = FRONTMATTER_LINE.exec(line);
    if (match === null) throw new CoachArticleError(`${name}: bad frontmatter line "${line}".`);
    const [, key = "", value = ""] = match;
    if (key in fields) throw new CoachArticleError(`${name}: duplicate frontmatter key ${key}.`);
    fields[key] = frontmatterValue(value.trim());
  }
  return fields;
}

export function parseCoachArticle(file: CoachArticleFile): CoachArticle {
  const match = FRONTMATTER.exec(file.source.replaceAll("\r\n", "\n"));
  if (match === null) throw new CoachArticleError(`${file.name}: missing frontmatter.`);
  const parsed = frontmatterSchema.safeParse(readFrontmatter(file.name, match[1] ?? ""));
  if (!parsed.success) {
    throw new CoachArticleError(`${file.name}: ${z.prettifyError(parsed.error)}`);
  }
  const { episode, ...fields } = parsed.data;
  if (file.name !== `${fields.slug}${ARTICLE_EXTENSION}`) {
    throw new CoachArticleError(`${file.name}: the file name must be the slug plus ".md".`);
  }
  return {
    ...fields,
    ...(episode === undefined ? {} : { episode }),
    body: parseMarkdown(match[2] ?? ""),
  };
}

function newestFirst(a: CoachArticle, b: CoachArticle): number {
  return b.published.localeCompare(a.published) || a.title.localeCompare(b.title);
}

export class CoachArticleLibrary {
  readonly articles: readonly CoachArticle[];
  readonly #bySlug: ReadonlyMap<string, CoachArticle>;

  constructor(articles: readonly CoachArticle[], visibility: ArticleVisibility) {
    const bySlug = new Map<string, CoachArticle>();
    for (const article of articles) {
      if (bySlug.has(article.slug)) {
        throw new CoachArticleError(`Two articles use the slug ${article.slug}.`);
      }
      bySlug.set(article.slug, article);
    }
    this.articles = articles
      .filter((article) => visibility === "with-drafts" || !article.draft)
      .toSorted((a, b) => newestFirst(a, b));
    this.#bySlug = new Map(this.articles.map((article) => [article.slug, article]));
  }

  find(slug: string): CoachArticle | undefined {
    return this.#bySlug.get(slug);
  }

  /** The slug a request path names, when it is exactly one served article. */
  findByPath(path: string): CoachArticle | undefined {
    if (!path.startsWith(COACH_ARTICLE_PREFIX)) return undefined;
    return this.find(path.slice(COACH_ARTICLE_PREFIX.length));
  }
}

export function readCoachArticleFiles(
  directory: URL = DEFAULT_ARTICLE_DIRECTORY,
): readonly CoachArticleFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(ARTICLE_EXTENSION))
    .toSorted()
    .map((name) => ({ name, source: readFileSync(new URL(name, directory), "utf8") }));
}

export function loadCoachArticles(
  visibility: ArticleVisibility,
  files: readonly CoachArticleFile[] = readCoachArticleFiles(),
): CoachArticleLibrary {
  return new CoachArticleLibrary(
    files.map((file) => parseCoachArticle(file)),
    visibility,
  );
}

export function articlePath(article: Pick<CoachArticle, "slug">): string {
  return `${COACH_ARTICLE_PREFIX}${article.slug}`;
}

export function episodeUrl(episode: string): string {
  return new URL(`episodes/${episode}`, COACH_LEARN_URL).href;
}

export interface ArticleListData {
  readonly articles: readonly Omit<CoachArticle, "body">[];
}

export interface ArticleData {
  readonly article: CoachArticle;
}

export interface CoachArticlePages {
  readonly list: PageDef<typeof COACH_ARTICLES_PATH, ArticleListData>;
  readonly article: PageDef<typeof COACH_ARTICLE_PATH, ArticleData>;
}

export interface CoachArticlePagesModule {
  readonly coachArticlePages: (library: CoachArticleLibrary) => CoachArticlePages;
}

/** What the coach host needs to serve parent-guide articles, the sitemap and robots.txt. */
export interface CoachArticles {
  readonly library: CoachArticleLibrary;
  readonly pages: CoachArticlePages;
}
