import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions, LestoResponse } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { coachArticlePages } from "../app/coach/article-pages";
import {
  articleVisibilityFor,
  CoachArticleError,
  episodeUrl,
  loadCoachArticles,
  parseCoachArticle,
  readCoachArticleFiles,
} from "../app/coach/articles";
import type { ArticleVisibility, CoachArticleFile } from "../app/coach/articles";
import { COACH_LEARN_URL } from "../app/coach/content";
import { coachHome } from "../app/coach/home-page";
import { MarkdownError, parseMarkdown } from "../app/coach/markdown";
import { coachRobotsTxt, coachSitemapXml } from "../app/coach/sitemap";
import { ballplayerHome } from "../app/ballplayer/home-page";
import { withBrandRoutes, withBrandSecurity } from "../app/server/brand-routing";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  COACH_CONTENT_SECURITY_POLICY,
} from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import { registerRuntimePages } from "../runtime/web-surface";
import { findThirdPartyRisks, hasInlineScript, hasInlineStyle } from "./support/third-party";

const COACH_HOST = "dimasciobaseball.com";

const DEV_COACH_HOST = "coach.localhost:3000";

const OTHER_BRAND_HOSTS = ["snackduty.test", "ballplayer.co"];

const SEO_PATHS = ["/articles", "/sitemap.xml", "/robots.txt"];

const repoArticles = loadCoachArticles("with-drafts").articles;

function headerNamed(response: AnyLestoResponse, name: string): string | string[] | undefined {
  const entry = Object.entries(response.headers).find(([header]) => header.toLowerCase() === name);
  return entry?.[1];
}

function policyOf(response: AnyLestoResponse): string | string[] | undefined {
  return headerNamed(response, "content-security-policy");
}

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function withHost(host: string): HandleOptions {
  return { headers: { host } };
}

async function get(app: Pick<App, "handle">, path: string, host: string) {
  return await app.handle("GET", path, withHost(host));
}

function articleFile(fields: Record<string, string>, body = "Some words."): CoachArticleFile {
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return {
    name: `${fields["slug"] ?? "missing"}.md`,
    source: `---\n${frontmatter}\n---\n\n${body}\n`,
  };
}

const publishedFields = {
  title: "A published guide",
  description: "A guide that is out.",
  slug: "published-guide",
  published: "2026-10-01",
  draft: "false",
};

const draftFields = {
  title: "A draft guide",
  description: "A guide that is not out yet.",
  slug: "draft-guide",
  published: "2026-11-01",
  draft: "true",
  episode: "run-to-first",
};

async function expectPlainNotFound(response: AnyLestoResponse, policy: string): Promise<void> {
  expect(response.status).toBe(404);
  expect(policyOf(response)).toBe(policy);
  expect(await textOf(response)).toBe("Not Found");
}

async function expectCleanCoachPage(response: AnyLestoResponse): Promise<string> {
  const html = await textOf(response);
  expect(response.status).toBe(200);
  expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
  expect(html).toContain('data-brand="coach"');
  expect(html).not.toContain("/client.js");
  expect(hasInlineStyle(html)).toBe(false);
  expect(hasInlineScript(html)).toBe(false);
  return html;
}

function absoluteUrlsIn(html: string): string[] {
  return findThirdPartyRisks(html, "markup").toSorted();
}

describe("the repo articles", () => {
  it("are the three parent guides, all drafts", () => {
    expect(repoArticles.map((article) => article.slug).toSorted()).toEqual([
      "first-baseball-glove",
      "throwing-catching-drills-at-home",
      "what-is-coach-pitch",
    ]);
    for (const article of repoArticles) expect(article.draft).toBe(true);
  });

  it("are hidden outside development", () => {
    expect(loadCoachArticles("published-only").articles).toEqual([]);
    expect(articleVisibilityFor("development")).toBe("with-drafts");
    for (const mode of ["staging", "production", "", "Development"]) {
      expect(articleVisibilityFor(mode)).toBe("published-only");
    }
  });

  it("link only episodes from the learn catalog", () => {
    const episodes = repoArticles.flatMap((article) =>
      article.episode === undefined ? [] : [article.episode],
    );
    expect(episodes).toEqual(["run-to-first"]);
  });

  it("stay between 400 and 700 words", () => {
    for (const file of readCoachArticleFiles()) {
      const body = file.source.split("\n---\n")[1] ?? "";
      const words = body.split(/\s+/u).filter((word) => word !== "").length;
      expect(words).toBeGreaterThanOrEqual(400);
      expect(words).toBeLessThanOrEqual(700);
    }
  });
});

describe("parseCoachArticle", () => {
  it("reads the frontmatter and the body", () => {
    const article = parseCoachArticle(articleFile(draftFields, "## Start\n\nHello **there**."));

    expect(article).toEqual({
      title: "A draft guide",
      description: "A guide that is not out yet.",
      slug: "draft-guide",
      published: "2026-11-01",
      draft: true,
      episode: "run-to-first",
      body: [
        { kind: "heading", level: 2, children: [{ kind: "text", text: "Start" }] },
        {
          kind: "paragraph",
          children: [
            { kind: "text", text: "Hello " },
            { kind: "strong", children: [{ kind: "text", text: "there" }] },
            { kind: "text", text: "." },
          ],
        },
      ],
    });
  });

  it.each([
    ["a missing draft flag", { ...publishedFields, draft: "" }],
    ["a draft flag that is not a boolean", { ...publishedFields, draft: "yes" }],
    ["a bad date", { ...publishedFields, published: "November 1" }],
    ["a bad slug", { ...publishedFields, slug: "Bad Slug" }],
    ["a bad episode slug", { ...publishedFields, episode: "../x" }],
    ["an unknown key", { ...publishedFields, author: "someone" }],
  ])("refuses %s", (_label, fields) => {
    expect(() => parseCoachArticle(articleFile(fields))).toThrow(CoachArticleError);
  });

  it("refuses a file name that is not the slug", () => {
    const file = { ...articleFile(publishedFields), name: "other.md" };
    expect(() => parseCoachArticle(file)).toThrow(CoachArticleError);
  });

  it("refuses two articles with one slug", () => {
    const file = articleFile(publishedFields);
    expect(() => loadCoachArticles("with-drafts", [file, file])).toThrow(CoachArticleError);
  });
});

describe("parseMarkdown", () => {
  it("reads lists, emphasis and same-origin links", () => {
    expect(parseMarkdown("- one *two*\n- [three](/book)\n\n1. first\n2. second")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { kind: "text", text: "one " },
            { kind: "emphasis", children: [{ kind: "text", text: "two" }] },
          ],
          [{ kind: "link", href: "/book", children: [{ kind: "text", text: "three" }] }],
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]],
      },
    ]);
  });

  it.each([
    "[x](https://example.com/)",
    "[x](//example.com/)",
    "[x](javascript:alert)",
    "[x](mailto:a@b.c)",
  ])("refuses the link %s", (source) => {
    expect(() => parseMarkdown(source)).toThrow(MarkdownError);
  });

  it("refuses a level 1 heading, because the title is the page heading", () => {
    expect(() => parseMarkdown("# Title")).toThrow(MarkdownError);
  });

  it("keeps markup as text", () => {
    expect(parseMarkdown("<script>x</script>")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "<script>x</script>" }] },
    ]);
  });
});

describe("the coach sitemap and robots.txt", () => {
  const library = loadCoachArticles("published-only", [
    articleFile(publishedFields),
    articleFile(draftFields),
  ]);

  it("lists home, book, articles and each served article with absolute URLs", () => {
    const xml = coachSitemapXml(library, true);
    expect(xml).toContain("<loc>https://dimasciobaseball.com/</loc>");
    expect(xml).toContain("<loc>https://dimasciobaseball.com/book</loc>");
    expect(xml).toContain("<loc>https://dimasciobaseball.com/articles</loc>");
    expect(xml).toContain(
      "<loc>https://dimasciobaseball.com/articles/published-guide</loc><lastmod>2026-10-01</lastmod>",
    );
    expect(xml).not.toContain("draft-guide");
  });

  it("leaves out /book when booking is closed", () => {
    expect(coachSitemapXml(library, false)).not.toContain("/book");
  });

  it("points robots.txt at the sitemap", () => {
    expect(coachRobotsTxt()).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://dimasciobaseball.com/sitemap.xml\n",
    );
  });
});

const fallthrough: LestoResponse = { status: 404, headers: {}, body: "shared app" };

function fixtureRouter(visibility: ArticleVisibility) {
  const library = loadCoachArticles(visibility, [
    articleFile(publishedFields, "Read [this](/book).\n\n## More\n\n- a\n- b"),
    articleFile(draftFields),
  ]);
  return {
    handle: withBrandSecurity(
      withBrandRoutes(() => Promise.resolve(fallthrough), {
        ballplayerHome,
        coachHome,
        coachArticles: { library, pages: coachArticlePages(library) },
      }),
    ),
  };
}

describe("coach article routes with a published and a draft article", () => {
  const published = fixtureRouter("published-only");
  const withDrafts = fixtureRouter("with-drafts");

  it("lists only the published article outside development", async () => {
    const html = await expectCleanCoachPage(await get(published, "/articles", COACH_HOST));
    expect(html).toContain('href="/articles/published-guide"');
    expect(html).not.toContain("draft-guide");
    expect(html).toContain('href="https://dimasciobaseball.com/articles"');
  });

  it("serves the published article with its metadata and a lesson link", async () => {
    const html = await expectCleanCoachPage(
      await get(published, "/articles/published-guide", COACH_HOST),
    );
    expect(html).toContain("<title>A published guide | DiMascio Baseball</title>");
    expect(html).toContain('content="A guide that is out."');
    expect(html).toContain(
      '<link rel="canonical" href="https://dimasciobaseball.com/articles/published-guide"',
    );
    expect(html).toContain('href="/book"');
    expect(html).toContain("<h2");
    expect(html).toContain("<li>a</li>");
    expect(html).not.toContain(COACH_LEARN_URL);
    expect(absoluteUrlsIn(html)).toEqual(["https://dimasciobaseball.com/articles/published-guide"]);
  });

  it("answers a draft with a plain 404 outside development", async () => {
    await expectPlainNotFound(
      await get(published, "/articles/draft-guide", COACH_HOST),
      COACH_CONTENT_SECURITY_POLICY,
    );
    expect(await textOf(await get(published, "/sitemap.xml", COACH_HOST))).not.toContain(
      "draft-guide",
    );
  });

  it("lists and serves the draft, newest first, in development", async () => {
    const list = await expectCleanCoachPage(await get(withDrafts, "/articles", DEV_COACH_HOST));
    expect(list.indexOf("draft-guide")).toBeLessThan(list.indexOf("published-guide"));
    const html = await expectCleanCoachPage(
      await get(withDrafts, "/articles/draft-guide", DEV_COACH_HOST),
    );
    expect(html).toContain(`href="${episodeUrl("run-to-first")}"`);
    expect(episodeUrl("run-to-first")).toBe(
      "https://learn.dimasciobaseball.com/episodes/run-to-first",
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<img");
    expect(absoluteUrlsIn(html)).toEqual([
      "https://dimasciobaseball.com/articles/draft-guide",
      episodeUrl("run-to-first"),
    ]);
    expect(await textOf(await get(withDrafts, "/sitemap.xml", DEV_COACH_HOST))).toContain(
      "<loc>https://dimasciobaseball.com/articles/draft-guide</loc>",
    );
  });

  it.each([
    "/articles/",
    "/articles/missing",
    "/articles/published-guide/x",
    "/articles/PUBLISHED-GUIDE",
  ])("answers %s with a plain 404", async (path) => {
    await expectPlainNotFound(
      await get(published, path, COACH_HOST),
      COACH_CONTENT_SECURITY_POLICY,
    );
  });

  it("refuses a post to the article paths", async () => {
    const response = await published.handle("POST", "/articles", withHost(COACH_HOST));
    await expectPlainNotFound(response, COACH_CONTENT_SECURITY_POLICY);
  });

  it("leaves the article paths to the shared app on Snackday and 404s them on Ballplayer", async () => {
    for (const path of [...SEO_PATHS, "/articles/published-guide"]) {
      expect(await textOf(await get(published, path, "snackduty.test"))).toBe("shared app");
      await expectPlainNotFound(
        await get(published, path, "ballplayer.co"),
        BALLPLAYER_CONTENT_SECURITY_POLICY,
      );
    }
  });
});

describe("coach articles in staging (runtime/web-surface.ts)", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-coach-articles-"));
    runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL("https://staging.snackduty.test"),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it("lists no draft", async () => {
    const html = await expectCleanCoachPage(await get(app(), "/articles", COACH_HOST));
    for (const article of repoArticles) {
      expect(html).not.toContain(article.slug);
      expect(html).not.toContain(article.title);
    }
  });

  it.each(repoArticles.map((article) => article.slug))(
    "answers the draft %s with a plain 404",
    async (slug) => {
      await expectPlainNotFound(
        await get(app(), `/articles/${slug}`, COACH_HOST),
        COACH_CONTENT_SECURITY_POLICY,
      );
    },
  );

  it("serves a sitemap with home, book and articles and no draft", async () => {
    const response = await get(app(), "/sitemap.xml", COACH_HOST);
    const xml = await textOf(response);

    expect(response.status).toBe(200);
    expect(headerNamed(response, "content-type")).toBe("application/xml; charset=utf-8");
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1])).toEqual([
      "https://dimasciobaseball.com/",
      "https://dimasciobaseball.com/book",
      "https://dimasciobaseball.com/articles",
    ]);
  });

  it("serves robots.txt", async () => {
    const response = await get(app(), "/robots.txt", COACH_HOST);

    expect(response.status).toBe(200);
    expect(headerNamed(response, "content-type")).toBe("text/plain; charset=utf-8");
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(await textOf(response)).toBe(coachRobotsTxt());
  });

  it("links the home page to the guides", async () => {
    const html = await textOf(await get(app(), "/", COACH_HOST));
    expect(html).toContain("For parents");
    expect(html).toContain('href="/articles"');
  });

  it.each(OTHER_BRAND_HOSTS)("has no article, sitemap or robots path on %s", async (host) => {
    for (const path of SEO_PATHS) {
      expect((await get(app(), path, host)).status).toBe(404);
    }
  });
});

describe("coach articles in dev (lesto.app.ts)", () => {
  let app: App | undefined;

  function devApp(): App {
    if (app === undefined) throw new Error("dev app did not open");
    return app;
  }

  beforeAll(async () => {
    process.env["LESTO_DB"] = ":memory:";
    const { default: applicationConfig } = await import("../lesto.app");
    const config = await applicationConfig();
    await registerRuntimePages(config.app);
    app = await createApp(config);
  });

  it("lists every draft, newest first", async () => {
    const html = await expectCleanCoachPage(await get(devApp(), "/articles", DEV_COACH_HOST));
    for (const article of repoArticles) expect(html).toContain(article.title);
  });

  it.each(repoArticles.map((article) => article.slug))(
    "serves the draft %s with metadata, a lesson link and no media",
    async (slug) => {
      const article = repoArticles.find((candidate) => candidate.slug === slug);
      if (article === undefined) throw new Error(`no article ${slug}`);
      const html = await expectCleanCoachPage(
        await get(devApp(), `/articles/${slug}`, DEV_COACH_HOST),
      );

      expect(html).toContain(
        `<link rel="canonical" href="https://dimasciobaseball.com/articles/${slug}"`,
      );
      expect(html).toContain('href="/book"');
      expect(html).toContain("Request a lesson");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<video");
      const episodeLinks = article.episode === undefined ? [] : [episodeUrl(article.episode)];
      expect(absoluteUrlsIn(html)).toEqual(
        [`https://dimasciobaseball.com/articles/${slug}`, ...episodeLinks].toSorted(),
      );
    },
  );

  it("lists drafts in the dev sitemap", async () => {
    const xml = await textOf(await get(devApp(), "/sitemap.xml", DEV_COACH_HOST));
    for (const article of repoArticles) {
      expect(xml).toContain(`<loc>https://dimasciobaseball.com/articles/${article.slug}</loc>`);
    }
  });

  it("has no article path on the dev Snackday host", async () => {
    expect((await get(devApp(), "/articles", "localhost:3000")).status).toBe(404);
  });
});
