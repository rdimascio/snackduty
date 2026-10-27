import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTENT_SECURITY_POLICY } from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import { registerRuntimePages, withBrandPolicy, withRuntimeAssets } from "../runtime/web-surface";
import { findThirdPartyRisks, hasInlineScript, hasInlineStyle } from "./support/third-party";

const EXPECTED_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const REQUIRED_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
];

const ALLOWED_SOURCES: ReadonlySet<string> = new Set(["'self'", "'none'"]);

const FONT_FILE = "inter-latin-wght-normal.woff2";

const fontBytes = new Uint8Array(
  readFileSync(new URL(`../public/fonts/${FONT_FILE}`, import.meta.url)),
);

const BALLPLAYER_HOSTS = ["ballplayer.co", "www.ballplayer.co", "ballplayer.localhost:3000"];

const SNACKDAY_PAGES: readonly [string, number][] = [
  ["/features", 200],
  ["/app", 200],
  ["/invite/x", 404],
];

const SNACKDAY_PAGE_PATHS = SNACKDAY_PAGES.map(([path]) => path);

const SNACKDAY_HOSTS = [
  "staging.snackduty.test",
  "localhost:3000",
  "ballplayer.co.evil.test",
  undefined,
];

function directivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/u);
    if (name !== undefined && name !== "") {
      expect(directives.has(name.toLowerCase())).toBe(false);
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

function expectStrictPolicy(policy: unknown): void {
  expect(policy).toBe(EXPECTED_POLICY);
  const directives = directivesOf(typeof policy === "string" ? policy : "");
  expect([...directives.keys()].toSorted()).toEqual(REQUIRED_DIRECTIVES.toSorted());
  for (const [name, sources] of directives) {
    expect({ name, sources: sources.length > 0 }).toEqual({ name, sources: true });
    for (const source of sources) {
      expect({ name, source, allowed: ALLOWED_SOURCES.has(source.toLowerCase()) }).toEqual({
        name,
        source,
        allowed: true,
      });
    }
  }
}

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

function withHost(host: string | undefined): HandleOptions {
  return host === undefined ? { headers: {} } : { headers: { host } };
}

async function get(app: App, path: string, host: string | undefined): Promise<AnyLestoResponse> {
  return await app.handle("GET", path, withHost(host));
}

async function expectBallplayerHome(response: AnyLestoResponse): Promise<string> {
  const html = await textOf(response);
  expect(response.status).toBe(200);
  expectStrictPolicy(policyOf(response));
  expect(html).toContain("<title>Ballplayer</title>");
  expect(html).toContain('content="Train like a ballplayer."');
  expect(html).toContain('data-brand="ballplayer"');
  expect(html).toContain("Sample card");
  expect(html).toContain("tier-gold");
  expect(html).toContain('href="/styles.css"');
  expect(html).not.toContain("snack day");
  expect(html).not.toContain("/client.js");
  return html;
}

async function expectBallplayerNotFound(response: AnyLestoResponse): Promise<void> {
  expect(response.status).toBe(404);
  expectStrictPolicy(policyOf(response));
  expect(await textOf(response)).toBe("Not Found");
}

async function expectSnackdayPage(response: AnyLestoResponse, status: number): Promise<void> {
  const html = await textOf(response);
  expect(response.status).toBe(status);
  expect(policyOf(response)).toBeUndefined();
  expect(html).not.toContain('data-brand="ballplayer"');
}

async function expectSnackdayHome(response: AnyLestoResponse): Promise<void> {
  const html = await textOf(response);
  expect(response.status).toBe(200);
  expect(policyOf(response)).toBeUndefined();
  expect(html).toContain("Snackday — youth sports, minus the chaos");
  expect(html).toContain("Don&#x27;t forget");
  expect(html).not.toContain('data-brand="ballplayer"');
  expect(html).not.toContain("Sample card");
}

describe("the shared Ballplayer policy", () => {
  it("is the exact strict policy", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(EXPECTED_POLICY);
    expectStrictPolicy(CONTENT_SECURITY_POLICY);
  });

  it("rejects a policy that loosens any directive", () => {
    const loosened = [
      EXPECTED_POLICY.replace("img-src 'self'", "img-src 'self' https://cdn.example"),
      EXPECTED_POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
      EXPECTED_POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
      EXPECTED_POLICY.replace("img-src 'self'", "img-src 'self' data:"),
      EXPECTED_POLICY.replace("connect-src 'self'", "connect-src *"),
      EXPECTED_POLICY.replace("; frame-ancestors 'none'", ""),
    ];
    for (const policy of loosened) {
      expect(() => expectStrictPolicy(policy)).toThrow();
    }
  });
});

describe("brands in production (runtime/web-surface.ts)", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-ballplayer-brand-"));
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

  it.each(BALLPLAYER_HOSTS)("renders the Ballplayer landing page on %s", async (host) => {
    await expectBallplayerHome(await get(app(), "/", host));
  });

  it.each(SNACKDAY_HOSTS)("renders the unchanged Snackday page on %j", async (host) => {
    await expectSnackdayHome(await get(app(), "/", host));
  });

  it("renders Ballplayer HTML with no inline style or script and no other origin", async () => {
    const html = await textOf(await get(app(), "/", "ballplayer.co"));

    expect(hasInlineStyle(html)).toBe(false);
    expect(hasInlineScript(html)).toBe(false);
    expect(findThirdPartyRisks(html, "markup")).toEqual([]);
  });

  it("lists each area stat as a full area name term followed by its rating", async () => {
    const html = await textOf(await get(app(), "/", "ballplayer.co"));
    const stats = html.slice(html.indexOf("<dl"), html.indexOf("</dl>"));
    const pairs = [...stats.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(\d+)<\/dd>/gu)].map(
      ([, term, rating]) => [term?.match(/sr-only">([^<]+)</u)?.[1], Number(rating)],
    );

    expect(pairs).toEqual([
      ["Hitting", 86],
      ["Fielding", 88],
      ["Throwing", 81],
      ["Speed", 79],
      ["Baseball IQ", 85],
    ]);
  });

  it("answers HEAD / on the Ballplayer host with the policy", async () => {
    const response = await app().handle("HEAD", "/", withHost("ballplayer.co"));

    expect(response.status).toBe(200);
    expectStrictPolicy(policyOf(response));
  });

  it("serves a self-hosted font on the Ballplayer host with the policy", async () => {
    const response = await get(app(), `/fonts/${FONT_FILE}`, "ballplayer.co");

    expect(response.status).toBe(200);
    expect(headerNamed(response, "content-type")).toBe("font/woff2");
    expect(response.body).toEqual(fontBytes);
    expectStrictPolicy(policyOf(response));
  });

  it("refuses files that are not bundled fonts", async () => {
    for (const path of ["/fonts/LICENSE-inter.txt", "/fonts/..%2Fpackage.json", "/fonts/"]) {
      const response = await get(app(), path, "ballplayer.co");
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expectStrictPolicy(policyOf(response));
    }
  });

  it("puts the policy on other Ballplayer-host responses", async () => {
    const missing = await get(app(), "/missing", "ballplayer.co");
    const api = await get(app(), "/api/teams", "ballplayer.co");

    expect(missing.status).toBe(404);
    expectStrictPolicy(policyOf(missing));
    expect(api.status).toBe(401);
    expectStrictPolicy(policyOf(api));
  });

  it.each(SNACKDAY_PAGE_PATHS)(
    "answers %s on the Ballplayer host with a 404 and the policy",
    async (path) => {
      await expectBallplayerNotFound(await get(app(), path, "ballplayer.co"));
    },
  );

  it.each(SNACKDAY_PAGES)("renders %s unchanged on a Snackday host", async (path, status) => {
    await expectSnackdayPage(await get(app(), path, "staging.snackduty.test"), status);
  });

  it("puts the policy on runtime wrapper responses for the Ballplayer host only", async () => {
    const requests: readonly [string, string, number][] = [
      ["GET", "/__snackday/release", 404],
      ["GET", "/api/dev/session", 404],
      ["GET", "/calendar/feed/token", 404],
      ["POST", "/api/teams/team/invitations", 503],
    ];
    for (const [method, path, status] of requests) {
      const ballplayer = await app().handle(method, path, withHost("ballplayer.co"));
      const snackday = await app().handle(method, path, withHost("staging.snackduty.test"));

      expect({ path, status: ballplayer.status }).toEqual({ path, status });
      expect({ path, policy: policyOf(ballplayer) }).toEqual({ path, policy: EXPECTED_POLICY });
      expect({ path, status: snackday.status }).toEqual({ path, status });
      expect({ path, policy: policyOf(snackday) }).toEqual({ path, policy: undefined });
    }
  });

  it("leaves Snackday responses without the policy and without Ballplayer fonts", async () => {
    const font = await get(app(), `/fonts/${FONT_FILE}`, "staging.snackduty.test");
    const api = await get(app(), "/api/teams", "staging.snackduty.test");

    expect(font.status).toBe(404);
    expect(policyOf(font)).toBeUndefined();
    expect(api.status).toBe(401);
    expect(policyOf(api)).toBeUndefined();
  });
});

describe("brands on runtime static assets", () => {
  let out = "";

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "snackday-ballplayer-assets-"));
    await writeFile(join(out, "styles.css"), "body{color:red}");
  });

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const fallthrough: App = {
    migrationsApplied: [],
    handle: () => Promise.resolve({ status: 404, headers: {}, body: "" }),
  };

  it("puts the policy on the stylesheet for the Ballplayer host at the outer boundary", async () => {
    const response = await get(
      withBrandPolicy(withRuntimeAssets(fallthrough, out)),
      "/styles.css",
      "ballplayer.co",
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("body{color:red}");
    expectStrictPolicy(policyOf(response));
  });

  it("adds no policy inside the asset wrapper", async () => {
    const response = await get(withRuntimeAssets(fallthrough, out), "/styles.css", "ballplayer.co");

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBeUndefined();
  });

  it("leaves the stylesheet for a Snackday host unchanged", async () => {
    const response = await get(
      withBrandPolicy(withRuntimeAssets(fallthrough, out)),
      "/styles.css",
      "snackday.app",
    );

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBeUndefined();
  });
});

describe("brands in dev (lesto.app.ts)", () => {
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

  it.each(BALLPLAYER_HOSTS)("renders the Ballplayer landing page on %s", async (host) => {
    await expectBallplayerHome(await get(devApp(), "/", host));
  });

  it.each(SNACKDAY_HOSTS)("renders the unchanged Snackday page on %j", async (host) => {
    await expectSnackdayHome(await get(devApp(), "/", host));
  });

  it("serves a self-hosted font on the Ballplayer host with the policy", async () => {
    const response = await get(devApp(), `/fonts/${FONT_FILE}`, BALLPLAYER_HOSTS[2]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(fontBytes);
    expectStrictPolicy(policyOf(response));
  });

  it.each(SNACKDAY_PAGE_PATHS)(
    "answers %s on the Ballplayer host with a 404 and the policy",
    async (path) => {
      await expectBallplayerNotFound(await get(devApp(), path, "ballplayer.localhost:3000"));
    },
  );

  it.each(SNACKDAY_PAGES)("renders %s unchanged on a Snackday host", async (path, status) => {
    await expectSnackdayPage(await get(devApp(), path, "localhost:3000"), status);
  });

  it("puts the policy on a Ballplayer-host API response only", async () => {
    const ballplayer = await get(devApp(), "/api/teams", "ballplayer.localhost:3000");
    const snackday = await get(devApp(), "/api/teams", "localhost:3000");

    expect(ballplayer.status).toBe(401);
    expectStrictPolicy(policyOf(ballplayer));
    expect(snackday.status).toBe(401);
    expect(policyOf(snackday)).toBeUndefined();
  });
});
