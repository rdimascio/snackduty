import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accounts, people, VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
import { withBrandSecurity } from "../app/server/brand-routing";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  REEL_MEDIA_ORIGIN,
  SNACKDAY_CONTENT_SECURITY_POLICY,
} from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import { registerRuntimePages, withBrandPolicy, withRuntimeAssets } from "../runtime/web-surface";
import worker from "../worker";

const SNACKDAY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://media.dimasciobaseball.com; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const BALLPLAYER_POLICY =
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

const KEYWORD_SOURCES: ReadonlySet<string> = new Set(["'self'", "'none'"]);

const SNACKDAY_ORIGIN_ALLOWANCE: Readonly<Record<string, readonly string[]>> = {
  "img-src": ["https://media.dimasciobaseball.com"],
};

const SNACKDAY_HOST = "staging.snackduty.test";

const BALLPLAYER_HOST = "ballplayer.co";

const LESTO_LAYOUT_WRAPPER = /^<div data-lesto-layout="\d+" style="display:contents">$/u;

function directivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/u);
    if (name === undefined || name === "") continue;
    if (directives.has(name.toLowerCase())) throw new Error(`duplicate directive ${name}`);
    directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

function looseningsOf(
  policy: string,
  allowance: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const directives = directivesOf(policy);
  const found: string[] = [];
  for (const name of REQUIRED_DIRECTIVES) {
    if (!directives.has(name)) found.push(`${name} is missing`);
  }
  for (const [name, sources] of directives) {
    if (!REQUIRED_DIRECTIVES.includes(name)) found.push(`${name} is not an expected directive`);
    if (sources.length === 0) found.push(`${name} has no source`);
    const allowed = allowance[name] ?? [];
    for (const source of sources) {
      const lower = source.toLowerCase();
      if (KEYWORD_SOURCES.has(lower) || allowed.includes(lower)) continue;
      found.push(`${name} allows ${source}`);
    }
  }
  return found;
}

function headerNamed(response: AnyLestoResponse, name: string): string | string[] | undefined {
  return Object.entries(response.headers).find(([header]) => header.toLowerCase() === name)?.[1];
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

function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/giu)].flatMap(([tag, attributes]) =>
    /\bsrc=/iu.test(attributes ?? "") || /\btype="application\/json"/iu.test(attributes ?? "")
      ? []
      : [tag],
  );
}

function inlineStyledTags(html: string): string[] {
  return [...html.matchAll(/<[^>]*?[\s"'/]style\s*=[^>]*>/giu)].map(([tag]) => tag);
}

function unexpectedInlineStyles(html: string): string[] {
  return inlineStyledTags(html).filter((tag) => !LESTO_LAYOUT_WRAPPER.test(tag));
}

function expectNoInlineExecution(html: string): void {
  expect(executableInlineScripts(html)).toEqual([]);
  expect(unexpectedInlineStyles(html)).toEqual([]);
  expect(html).not.toMatch(/<style\b/iu);
  expect(html).not.toMatch(/\son[a-z]+\s*=/iu);
}

function withHost(host: string, extra: Record<string, string> = {}): HandleOptions {
  return { headers: { host, ...extra } };
}

describe("the brand policies", () => {
  it("serves Snackday the Ballplayer policy plus the Reel media origin in img-src only", () => {
    expect(SNACKDAY_CONTENT_SECURITY_POLICY).toBe(SNACKDAY_POLICY);
    expect(BALLPLAYER_CONTENT_SECURITY_POLICY).toBe(BALLPLAYER_POLICY);
    expect(REEL_MEDIA_ORIGIN).toBe("https://media.dimasciobaseball.com");
    expect(looseningsOf(SNACKDAY_CONTENT_SECURITY_POLICY, SNACKDAY_ORIGIN_ALLOWANCE)).toEqual([]);
    expect(looseningsOf(BALLPLAYER_CONTENT_SECURITY_POLICY)).toEqual([]);
    expect(SNACKDAY_CONTENT_SECURITY_POLICY.replace(` ${REEL_MEDIA_ORIGIN}`, "")).toBe(
      BALLPLAYER_CONTENT_SECURITY_POLICY,
    );
  });

  it.each(REQUIRED_DIRECTIVES)("fails when %s gains any looser source", (name) => {
    for (const source of [
      "https://cdn.example",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "data:",
      "*",
      "https:",
      "blob:",
    ]) {
      for (const [policy, allowance] of [
        [SNACKDAY_CONTENT_SECURITY_POLICY, SNACKDAY_ORIGIN_ALLOWANCE],
        [BALLPLAYER_CONTENT_SECURITY_POLICY, {}],
      ] as const) {
        const loosened = policy.replace(new RegExp(`(^|; )${name} `, "u"), `$1${name} ${source} `);
        expect(loosened).not.toBe(policy);
        expect(looseningsOf(loosened, allowance)).toEqual([`${name} allows ${source}`]);
      }
    }
  });

  it("fails when the Reel media origin reaches any directive other than img-src", () => {
    for (const name of REQUIRED_DIRECTIVES.filter((directive) => directive !== "img-src")) {
      const loosened = SNACKDAY_CONTENT_SECURITY_POLICY.replace(
        new RegExp(`(^|; )${name} `, "u"),
        `$1${name} ${REEL_MEDIA_ORIGIN} `,
      );
      expect(looseningsOf(loosened, SNACKDAY_ORIGIN_ALLOWANCE)).toEqual([
        `${name} allows ${REEL_MEDIA_ORIGIN}`,
      ]);
    }
    expect(looseningsOf(SNACKDAY_CONTENT_SECURITY_POLICY)).toEqual([
      `img-src allows ${REEL_MEDIA_ORIGIN}`,
    ]);
  });

  it("fails when a directive is removed", () => {
    for (const name of REQUIRED_DIRECTIVES) {
      const trimmed = SNACKDAY_CONTENT_SECURITY_POLICY.split("; ")
        .filter((directive) => !directive.startsWith(`${name} `))
        .join("; ");
      expect(looseningsOf(trimmed, SNACKDAY_ORIGIN_ALLOWANCE)).toEqual([`${name} is missing`]);
    }
  });
});

describe("Snackday in production (runtime/application.ts)", () => {
  let scratch = "";
  let out = "";
  let runtime: RuntimeApplication | undefined;
  let cookie = "";

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-csp-"));
    out = await mkdtemp(join(tmpdir(), "snackday-csp-assets-"));
    await writeFile(join(out, "styles.css"), "body{color:red}");
    await writeFile(join(out, "client.js"), "export {};");
    runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL(`https://${SNACKDAY_HOST}`),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
    const now = "2026-10-26T12:00:00.000Z";
    await runtime.db
      .insert(people)
      .values({
        id: "person_csp_probe",
        displayName: "CSP Probe Adult",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await runtime.db
      .insert(accounts)
      .values({
        id: "account_csp_probe",
        personId: "person_csp_probe",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const session = await runtime.sessions.create("account_csp_probe", 60_000);
    cookie = `${VERIFIED_SESSION_COOKIE}=${session.token}`;
    const team = await runtime.app.handle("POST", "/api/teams", {
      ...withHost(SNACKDAY_HOST, { cookie, "sec-fetch-site": "same-origin" }),
      body: { name: "CSP Falcons" },
    });
    expect(team.status).toBe(201);
  });

  afterAll(async () => {
    await runtime?.close();
    await rm(scratch, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  });

  it("puts the exact Snackday policy on /", async () => {
    const response = await app().handle("GET", "/", withHost(SNACKDAY_HOST));
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    expect(html).toContain('data-lesto-layout="0"');
    expectNoInlineExecution(html);
  });

  it("puts the exact Snackday policy on /app for a signed-in adult", async () => {
    const response = await app().handle("GET", "/app", withHost(SNACKDAY_HOST, { cookie }));
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    expect(html).toContain("CSP Falcons");
    expect(html).toContain('data-lesto-layout="0"');
    expect(html).toContain('src="/client.js"');
    expectNoInlineExecution(html);
  });

  it("puts the exact Snackday policy on /invite/x", async () => {
    const response = await app().handle("GET", "/invite/x", withHost(SNACKDAY_HOST));

    expect(response.status).toBe(404);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    expectNoInlineExecution(await textOf(response));
  });

  it("keeps island state in a JSON data block the browser does not execute", async () => {
    const response = await app().handle("GET", "/invite", withHost(SNACKDAY_HOST));
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    expect(html).toMatch(/<script type="application\/json" data-lesto-island-mount="">/u);
    expectNoInlineExecution(html);
  });

  it.each(["/styles.css", "/client.js"])(
    "puts the exact Snackday policy on the static asset %s",
    async (path) => {
      const fallthrough: App = {
        migrationsApplied: [],
        handle: () => Promise.resolve({ status: 404, headers: {}, body: "" }),
      };
      const response = await withBrandPolicy(withRuntimeAssets(fallthrough, out)).handle(
        "GET",
        path,
        withHost(SNACKDAY_HOST),
      );

      expect(response.status).toBe(200);
      expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    },
  );

  it("puts the exact Snackday policy on API and wrapper responses", async () => {
    const requests: readonly [string, string, number][] = [
      ["GET", "/api/teams", 401],
      ["GET", "/__snackday/release", 404],
      ["GET", "/calendar/feed/token", 404],
    ];
    for (const [method, path, status] of requests) {
      const response = await app().handle(method, path, withHost(SNACKDAY_HOST));
      expect({ path, status: response.status, policy: policyOf(response) }).toEqual({
        path,
        status,
        policy: SNACKDAY_POLICY,
      });
    }
  });
});

describe("Snackday in dev (lesto.app.ts)", () => {
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

  it.each([
    ["/", 200],
    ["/app", 200],
    ["/invite", 200],
    ["/invite/x", 404],
  ] as const)("puts the exact Snackday policy on %s", async (path, status) => {
    const response = await devApp().handle("GET", path, withHost("localhost:3000"));
    const html = await textOf(response);

    expect(response.status).toBe(status);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
    expectNoInlineExecution(html);
  });

  it("puts the exact Snackday policy on an API response", async () => {
    const response = await devApp().handle("GET", "/api/teams", withHost("localhost:3000"));

    expect(response.status).toBe(401);
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
  });
});

describe("the inline style allowance", () => {
  it("allows only the Lesto layout wrapper style", () => {
    expect(
      unexpectedInlineStyles(
        '<div data-lesto-layout="0" style="display:contents"><div data-lesto-layout="12" style="display:contents"></div></div>',
      ),
    ).toEqual([]);
  });

  it.each([
    '<p style="display:contents">',
    '<div data-lesto-layout="0" style="display:block">',
    '<div data-lesto-layout="0" class="x" style="display:contents">',
    '<div style="display:contents">',
  ])("rejects %s", (tag) => {
    expect(unexpectedInlineStyles(`${tag}x</div>`)).toEqual([tag]);
  });
});

describe("Snackday at the edge (worker.ts)", () => {
  const executionContext = { waitUntil: () => undefined };

  const missingAssets = { fetch: () => Promise.resolve(new Response("", { status: 404 })) };

  const stylesheetAssets = {
    fetch: (request: Request) =>
      Promise.resolve(
        new URL(request.url).pathname === "/styles.css"
          ? new Response("body{color:red}", { headers: { "content-type": "text/css" } })
          : new Response("", { status: 404 }),
      ),
  };

  function edgeRequest(host: string, path: string): Request {
    return new Request(`https://${host}${path}`, { headers: { host } });
  }

  it.each([
    [SNACKDAY_HOST, SNACKDAY_POLICY],
    [BALLPLAYER_HOST, BALLPLAYER_POLICY],
  ])("puts the %s policy on the / page", async (host, policy) => {
    const response = await worker.fetch(
      edgeRequest(host, "/"),
      { ASSETS: missingAssets },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(policy);
  });

  it.each([
    [SNACKDAY_HOST, SNACKDAY_POLICY],
    [BALLPLAYER_HOST, BALLPLAYER_POLICY],
  ])("puts the %s policy on a static asset", async (host, policy) => {
    const response = await worker.fetch(
      edgeRequest(host, "/styles.css"),
      { ASSETS: stylesheetAssets },
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body{color:red}");
    expect(response.headers.get("content-type")).toBe("text/css");
    expect(response.headers.get("content-security-policy")).toBe(policy);
  });

  it("replaces a policy the asset already carries", async () => {
    const assets = {
      fetch: () =>
        Promise.resolve(
          new Response("body{}", { headers: { "content-security-policy": "default-src *" } }),
        ),
    };
    const response = await worker.fetch(
      edgeRequest(SNACKDAY_HOST, "/styles.css"),
      { ASSETS: assets },
      executionContext,
    );

    expect(response.headers.get("content-security-policy")).toBe(SNACKDAY_POLICY);
  });
});

describe("the brand security wrapper", () => {
  const page = [
    '<div data-lesto-layout="0" style="display:contents">',
    '<textarea><div data-lesto-layout="1" style="display:contents"></textarea>',
    '<p title=\'<div data-lesto-layout="2" style="display:contents">\'>x</p>',
    "</div>",
  ].join("");

  it("passes a string HTML body through byte for byte with its Content-Length", async () => {
    const secured = withBrandSecurity(() =>
      Promise.resolve({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(new TextEncoder().encode(page).byteLength),
        },
        body: page,
      }),
    );
    const response = await secured("GET", "/", withHost(SNACKDAY_HOST));

    expect(await textOf(response)).toBe(page);
    expect(headerNamed(response, "content-length")).toBe(
      String(new TextEncoder().encode(page).byteLength),
    );
    expect(policyOf(response)).toBe(SNACKDAY_POLICY);
  });

  it("passes a streamed HTML body through unchanged", async () => {
    const bytes = new TextEncoder().encode(page);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const secured = withBrandSecurity(() =>
      Promise.resolve({ status: 200, headers: { "content-type": "text/html" }, body }),
    );
    const response = await secured("GET", "/", withHost(SNACKDAY_HOST));

    expect(response.body).toBe(body);
    expect(await textOf(response)).toBe(page);
  });
});
