import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSessionSchema } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { App } from "@lesto/kernel";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import type { AnyLestoResponse, HandleOptions, LestoResponse } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ballplayerHome } from "../app/ballplayer/home-page";
import { coachArticlePages } from "../app/coach/article-pages";
import { loadCoachArticles } from "../app/coach/articles";
import { coachHome } from "../app/coach/home-page";
import { applicationMigrations } from "../app/lib/server/composition";
import { withBrandRoutes, withBrandSecurity } from "../app/server/brand-routing";
import type { BrandPages, RequestHandle } from "../app/server/brand-routing";
import { TenantCache, tenantOfRequest } from "../app/tenant/tenant";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";

/** The exact headers main serves, copied as literals so a change to the policy builder cannot hide here. */
const SNACKDAY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://media.dimasciobaseball.com; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const STRICT_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const HOST_POLICIES: readonly (readonly [string, string])[] = [
  ["snackday.app", SNACKDAY_POLICY],
  ["www.snackday.app", SNACKDAY_POLICY],
  ["localhost:3000", SNACKDAY_POLICY],
  ["127.0.0.1:3000", SNACKDAY_POLICY],
  ["[::1]:3000", SNACKDAY_POLICY],
  ["dimasciobaseball.com", STRICT_POLICY],
  ["www.dimasciobaseball.com", STRICT_POLICY],
  ["coach.localhost:3000", STRICT_POLICY],
  ["ballplayer.co", STRICT_POLICY],
  ["www.ballplayer.co", STRICT_POLICY],
  ["ballplayer.localhost:3000", STRICT_POLICY],
  ["staging.snackduty.test", SNACKDAY_POLICY],
  ["ci.snackday.invalid", SNACKDAY_POLICY],
  ["learn.dimasciobaseball.com", SNACKDAY_POLICY],
];

const HOSTS = HOST_POLICIES.map(([host]) => host);

const RUNTIME_HOST = "staging.snackduty.test";

function withHost(host: string, extra: Record<string, string> = {}): HandleOptions {
  return { headers: { host, ...extra } };
}

function headerNamed(response: AnyLestoResponse, name: string): string | string[] | undefined {
  return Object.entries(response.headers).find(([header]) => header.toLowerCase() === name)?.[1];
}

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

describe("the runtime on the organization tables", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-tenant-"));
    runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL(`https://${RUNTIME_HOST}`),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it.each(HOST_POLICIES)("puts main's exact policy on / for %s", async (host, policy) => {
    const response = await app().handle("GET", "/", withHost(host));

    expect(response.status).toBe(200);
    expect(headerNamed(response, "content-security-policy")).toBe(policy);
  });

  it.each(HOSTS)("lets a same-origin POST through the origin check on %s", async (host) => {
    const response = await app().handle("POST", "/api/teams", {
      ...withHost(host, { "sec-fetch-site": "same-origin" }),
      body: { name: "Origin probe" },
    });

    expect(response.status).toBe(401);
  });

  it.each(HOSTS)("refuses a cross-site POST in the origin check on %s", async (host) => {
    const response = await app().handle("POST", "/api/teams", {
      ...withHost(host, { "sec-fetch-site": "cross-site" }),
      body: { name: "Origin probe" },
    });

    expect(response.status).toBe(403);
  });

  it.each(HOSTS)(
    "refuses a POST with no Sec-Fetch-Site and a foreign Origin on %s",
    async (host) => {
      const response = await app().handle("POST", "/api/teams", {
        ...withHost(host, { origin: "https://evil.test" }),
        body: { name: "Origin probe" },
      });

      expect(response.status).toBe(403);
    },
  );
});

const shared: RequestHandle = (method, path) =>
  Promise.resolve<LestoResponse>({
    status: 200,
    headers: { "content-type": "text/plain", "x-shared-app": `${method} ${path}` },
    body: `shared ${method} ${path}`,
  });

describe("routing on the tenant against routing on the static host map", () => {
  const articles = loadCoachArticles("published-only");
  const pages: BrandPages = {
    ballplayerHome,
    coachHome,
    coachArticles: { library: articles, pages: coachArticlePages(articles) },
  };

  const PATHS: readonly (readonly [string, string])[] = [
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

  it("answers every host and path byte for byte the same", async () => {
    const { db: sql, close } = await openSqlite(":memory:");
    try {
      await installSessionSchema(sql);
      await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
      const tenants = tenantOfRequest(createDb(sql, { dialect: "sqlite" }), new TenantCache());
      const fromTable = withBrandSecurity(
        withBrandRoutes(shared, pages, undefined, tenants),
        tenants,
      );
      const fromCode = withBrandSecurity(withBrandRoutes(shared, pages));

      for (const host of [...HOSTS, "", "Ballplayer.CO:8443", "dimasciobaseball.com."]) {
        for (const [method, path] of PATHS) {
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
