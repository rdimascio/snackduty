import { installSessionSchema } from "@lesto/auth";
import { createDb } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import type { LestoResponse } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ballplayerHome } from "../app/ballplayer/home-page";
import { coachArticlePages } from "../app/coach/article-pages";
import { loadCoachArticles } from "../app/coach/articles";
import { coachHome } from "../app/coach/home-page";
import { applicationMigrations } from "../app/lib/server/composition";
import { withBrandRoutes, withBrandSecurity } from "../app/server/brand-routing";
import type { BrandPages, RequestHandle } from "../app/server/brand-routing";
import { TenantCache, tenantResolver } from "../app/tenant/tenant";
import {
  SNACKDAY_POLICY,
  STRICT_POLICY,
  headerNamed,
  markerOf,
  openRuntimeFixture,
  textOf,
  withHost,
} from "./support/tenant-fixture";
import type { RuntimeFixture } from "./support/tenant-fixture";

type PolicyLabel = "snackday" | "strict";

type Snapshot = readonly [
  host: string,
  path: string,
  status: number,
  policy: PolicyLabel,
  contentType: string,
  cacheControl: string,
  marker: string,
];

const POLICY_BY_LABEL: Readonly<Record<PolicyLabel, string>> = {
  snackday: SNACKDAY_POLICY,
  strict: STRICT_POLICY,
};

const SNACKDAY_HOME = "title=Snackday — youth sports, minus the chaos brand=none";
const SNACKDAY_APP = "title=Team overview — Snackday brand=none";
const UNAUTHENTICATED = '{"error":"authentication required"}';
const HTML = "text/html; charset=utf-8";
const PLAIN = "text/plain";
const PLAIN_UTF8 = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

/** Captured from the runtime at base commit 29412b7, before the resolver existed. */
const MAIN_SNAPSHOTS: readonly Snapshot[] = [
  ["snackday.app", "/", 200, "snackday", HTML, "none", SNACKDAY_HOME],
  ["snackday.app", "/app", 200, "snackday", HTML, "none", SNACKDAY_APP],
  ["snackday.app", "/book", 404, "snackday", PLAIN, "none", "Not Found"],
  ["snackday.app", "/articles", 404, "snackday", PLAIN, "none", "Not Found"],
  ["snackday.app", "/api/teams", 401, "snackday", JSON_TYPE, "none", UNAUTHENTICATED],
  ["snackday.app", "/missing", 404, "snackday", PLAIN, "none", "Not Found"],
  ["dimasciobaseball.com", "/", 200, "strict", HTML, "none", "title=DiMascio Baseball brand=coach"],
  ["dimasciobaseball.com", "/app", 404, "strict", PLAIN_UTF8, "no-store", "Not Found"],
  [
    "dimasciobaseball.com",
    "/book",
    200,
    "strict",
    HTML,
    "none",
    "title=Request a lesson | DiMascio Baseball brand=coach",
  ],
  [
    "dimasciobaseball.com",
    "/articles",
    200,
    "strict",
    HTML,
    "none",
    "title=Guides for parents | DiMascio Baseball brand=coach",
  ],
  ["dimasciobaseball.com", "/api/teams", 401, "strict", JSON_TYPE, "none", UNAUTHENTICATED],
  ["dimasciobaseball.com", "/missing", 404, "strict", PLAIN_UTF8, "no-store", "Not Found"],
  ["ballplayer.co", "/", 200, "strict", HTML, "none", "title=Ballplayer brand=ballplayer"],
  [
    "ballplayer.co",
    "/app",
    200,
    "strict",
    HTML,
    "private, no-store",
    "title=Player cards — Ballplayer brand=ballplayer",
  ],
  ["ballplayer.co", "/book", 404, "strict", PLAIN_UTF8, "no-store", "Not Found"],
  ["ballplayer.co", "/articles", 404, "strict", PLAIN_UTF8, "no-store", "Not Found"],
  ["ballplayer.co", "/api/teams", 401, "strict", JSON_TYPE, "none", UNAUTHENTICATED],
  ["ballplayer.co", "/missing", 404, "strict", PLAIN_UTF8, "no-store", "Not Found"],
  ["staging.snackduty.test", "/", 200, "snackday", HTML, "none", SNACKDAY_HOME],
  ["staging.snackduty.test", "/app", 200, "snackday", HTML, "none", SNACKDAY_APP],
  ["staging.snackduty.test", "/book", 404, "snackday", PLAIN, "none", "Not Found"],
  ["staging.snackduty.test", "/articles", 404, "snackday", PLAIN, "none", "Not Found"],
  ["staging.snackduty.test", "/api/teams", 401, "snackday", JSON_TYPE, "none", UNAUTHENTICATED],
  ["staging.snackduty.test", "/missing", 404, "snackday", PLAIN, "none", "Not Found"],
];

describe("the runtime against main's frozen answers", () => {
  let fixture: RuntimeFixture | undefined;

  beforeAll(async () => {
    fixture = await openRuntimeFixture();
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it.each(MAIN_SNAPSHOTS)(
    "answers %s %s as main did",
    async (host, path, status, policy, contentType, cacheControl, marker) => {
      if (fixture === undefined) throw new Error("runtime did not open");
      const response = await fixture.runtime.app.handle("GET", path, withHost(host));

      expect({
        status: response.status,
        policy: headerNamed(response, "content-security-policy"),
        contentType: headerNamed(response, "content-type") ?? "none",
        cacheControl: headerNamed(response, "cache-control") ?? "none",
        marker: markerOf(await textOf(response)),
      }).toEqual({ status, policy: POLICY_BY_LABEL[policy], contentType, cacheControl, marker });
    },
  );
});

const shared: RequestHandle = (method, path) =>
  Promise.resolve<LestoResponse>({
    status: 200,
    headers: { "content-type": "text/plain", "x-shared-app": `${method} ${path}` },
    body: `shared ${method} ${path}`,
  });

const EQUIVALENCE_HOSTS = [
  "snackday.app",
  "www.snackday.app",
  "localhost:3000",
  "127.0.0.1:3000",
  "[::1]:3000",
  "dimasciobaseball.com",
  "www.dimasciobaseball.com",
  "coach.localhost:3000",
  "ballplayer.co",
  "www.ballplayer.co",
  "ballplayer.localhost:3000",
  "staging.snackduty.test",
  "ci.snackday.invalid",
  "learn.dimasciobaseball.com",
  "",
  "Ballplayer.CO:8443",
  "dimasciobaseball.com.",
];

const EQUIVALENCE_PATHS: readonly (readonly [string, string])[] = [
  ["GET", "/"],
  ["HEAD", "/"],
  ["GET", "/app"],
  ["GET", "/features"],
  ["GET", "/book"],
  ["GET", "/book/sent"],
  ["POST", "/book"],
  ["GET", "/articles"],
  ["GET", "/articles/what-is-coach-pitch"],
  ["GET", "/articles/missing"],
  ["GET", "/sitemap.xml"],
  ["GET", "/robots.txt"],
  ["GET", "/fonts/missing.woff2"],
  ["GET", "/api/teams"],
  ["POST", "/api/teams"],
  ["GET", "/__ballplayer/app"],
  ["GET", "/__lesto/health"],
  ["GET", "/styles.css"],
  ["GET", "/client.js"],
  ["GET", "/dev/sign-in"],
];

async function snapshot(response: LestoResponse): Promise<unknown> {
  return { status: response.status, headers: response.headers, body: await textOf(response) };
}

describe("resolver equivalence on the seeded rows", () => {
  const articles = loadCoachArticles("published-only");
  const pages: BrandPages = {
    ballplayerHome,
    coachHome,
    coachArticles: { library: articles, pages: coachArticlePages(articles) },
  };

  it("routes every seeded and fallback host from the table as the static host map does", async () => {
    const { db: sql, close } = await openSqlite(":memory:");
    try {
      await installSessionSchema(sql);
      await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
      const tenants = tenantResolver(createDb(sql, { dialect: "sqlite" }), new TenantCache());
      const fromTable = withBrandSecurity(
        withBrandRoutes(shared, pages, undefined, tenants),
        tenants,
      );
      const fromCode = withBrandSecurity(withBrandRoutes(shared, pages));

      for (const host of EQUIVALENCE_HOSTS) {
        for (const [method, path] of EQUIVALENCE_PATHS) {
          const table = await snapshot(await fromTable(method, path, withHost(host)));
          const code = await snapshot(await fromCode(method, path, withHost(host)));
          expect({ host, method, path, response: table }).toEqual({
            host,
            method,
            path,
            response: code,
          });
        }
      }
    } finally {
      close();
    }
  });
});
