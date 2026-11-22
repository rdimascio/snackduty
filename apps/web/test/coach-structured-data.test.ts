import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, LestoResponse } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ballplayerHome } from "../app/ballplayer/home-page";
import { coachArticlePages } from "../app/coach/article-pages";
import { loadCoachArticles } from "../app/coach/articles";
import type { CoachArticleFile } from "../app/coach/articles";
import { coachHome } from "../app/coach/home-page";
import { coachArticleJsonLd, coachBusinessJsonLd, jsonLdText } from "../app/coach/structured-data";
import { withBrandRoutes, withBrandSecurity } from "../app/server/brand-routing";
import { COACH_CONTENT_SECURITY_POLICY } from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";

const COACH_HOST = "dimasciobaseball.com";

const SCRIPT_OPEN = /<script\b([^>]*)>/giu;

const JSON_LD_BLOCK = /<script type="application\/ld\+json">([^<]*)<\/script>/gu;

const HOSTILE_TITLE = "Gloves </script><script>alert(1)</script> & more";

const expectedPerson = { "@type": "Person", name: "Coach Ryan" };

const expectedBusiness = {
  "@type": "SportsActivityLocation",
  name: "DiMascio Baseball",
  url: "https://dimasciobaseball.com/",
  description: "Private baseball lessons in Orange County.",
  areaServed: "Orange County, CA",
  founder: expectedPerson,
  employee: expectedPerson,
};

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function policyOf(response: AnyLestoResponse): string | string[] | undefined {
  return Object.entries(response.headers).find(
    ([header]) => header.toLowerCase() === "content-security-policy",
  )?.[1];
}

function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(JSON_LD_BLOCK)].map((match) => JSON.parse(match[1] ?? "") as unknown);
}

function scriptTypes(html: string): string[] {
  return [...html.matchAll(SCRIPT_OPEN)].map(([, attributes = ""]) => attributes.trim());
}

function articleFile(title: string, slug: string, draft: boolean): CoachArticleFile {
  return {
    name: `${slug}.md`,
    source: `---\ntitle: ${title}\ndescription: About ${slug}.\nslug: ${slug}\npublished: 2026-10-01\ndraft: ${draft}\n---\n\nSome words.\n`,
  };
}

const fallthrough: LestoResponse = { status: 404, headers: {}, body: "shared app" };

const library = loadCoachArticles("published-only", [
  articleFile("A published guide", "published-guide", false),
  articleFile(HOSTILE_TITLE, "hostile-guide", false),
  articleFile("A draft guide", "draft-guide", true),
]);

const fixture = withBrandSecurity(
  withBrandRoutes(() => Promise.resolve(fallthrough), {
    ballplayerHome,
    coachHome,
    coachArticles: { library, pages: coachArticlePages(library) },
  }),
);

function requireArticle(slug: string) {
  const article = library.find(slug);
  if (article === undefined) throw new Error(`fixture article ${slug} missing`);
  return article;
}

async function fixturePage(path: string): Promise<AnyLestoResponse> {
  return await fixture("GET", path, { headers: { host: COACH_HOST } });
}

describe("the coach JSON-LD values", () => {
  it("states only the business facts the site already shows", () => {
    expect(coachBusinessJsonLd()).toEqual({
      "@context": "https://schema.org",
      ...expectedBusiness,
    });
  });

  it("describes an article with the coach as author and the business as publisher", () => {
    expect(coachArticleJsonLd(requireArticle("published-guide"))).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "A published guide",
      description: "About published-guide.",
      datePublished: "2026-10-01",
      url: "https://dimasciobaseball.com/articles/published-guide",
      author: expectedPerson,
      publisher: expectedBusiness,
    });
  });

  it("escapes every < so the text cannot close its script element", () => {
    const text = jsonLdText(coachArticleJsonLd(requireArticle("hostile-guide")));

    expect(text).not.toContain("<");
    expect(text).toContain("\\u003c/script>");
    expect((JSON.parse(text) as { headline: string }).headline).toBe(HOSTILE_TITLE);
  });
});

describe("JSON-LD on rendered coach pages", () => {
  it("renders one Article block on a published article", async () => {
    const html = await textOf(await fixturePage("/articles/published-guide"));
    expect(jsonLdBlocks(html)).toEqual([coachArticleJsonLd(requireArticle("published-guide"))]);
  });

  it("keeps a </script> title inside the one block", async () => {
    const html = await textOf(await fixturePage("/articles/hostile-guide"));

    expect(scriptTypes(html)).toEqual(['type="application/ld+json"']);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    expect(html).not.toContain("<script>alert(1)");
    const [block] = jsonLdBlocks(html) as { headline: string }[];
    expect(block?.headline).toBe(HOSTILE_TITLE);
  });

  it("renders no block on the article list", async () => {
    expect(scriptTypes(await textOf(await fixturePage("/articles")))).toEqual([]);
  });

  it("serves no block for a draft outside development", async () => {
    const response = await fixturePage("/articles/draft-guide");
    expect(response.status).toBe(404);
    expect(await textOf(response)).toBe("Not Found");
  });
});

describe("JSON-LD in staging (runtime/web-surface.ts)", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  async function page(path: string): Promise<AnyLestoResponse> {
    return await app().handle("GET", path, { headers: { host: COACH_HOST } });
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-coach-json-ld-"));
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

  it("renders one SportsActivityLocation block on the home page", async () => {
    const html = await textOf(await page("/"));
    expect(jsonLdBlocks(html)).toEqual([{ "@context": "https://schema.org", ...expectedBusiness }]);
  });

  it("needs no CSP change: script-src stays 'self' and the only script is a non-executing data block", async () => {
    const response = await page("/");
    const policy = policyOf(response);

    expect(policy).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(
      String(policy)
        .split(";")
        .map((directive) => directive.trim()),
    ).toContain("script-src 'self'");
    expect(String(policy)).not.toMatch(/unsafe-inline|sha256-|nonce-/u);
    expect(scriptTypes(await textOf(response))).toEqual(['type="application/ld+json"']);
  });

  it.each(["first-baseball-glove", "what-is-coach-pitch", "throwing-catching-drills-at-home"])(
    "serves no block for the draft %s",
    async (slug) => {
      const response = await page(`/articles/${slug}`);
      expect(response.status).toBe(404);
      expect(await textOf(response)).not.toContain("<script");
    },
  );
});
