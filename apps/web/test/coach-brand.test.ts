import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COACH_LEARN_URL, lessonTypes } from "../app/coach/home-page";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  COACH_CONTENT_SECURITY_POLICY,
} from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import { registerRuntimePages } from "../runtime/web-surface";
import { findThirdPartyRisks, hasInlineScript, hasInlineStyle } from "./support/third-party";

const COACH_HOSTS = ["dimasciobaseball.com", "www.dimasciobaseball.com", "coach.localhost:3000"];

const COACH_NOT_FOUND_PATHS = ["/app", "/features", "/invite/x", "/dev/sign-in", "/missing"];

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

async function get(app: App, path: string, host: string): Promise<AnyLestoResponse> {
  return await app.handle("GET", path, withHost(host));
}

async function expectCoachHome(response: AnyLestoResponse): Promise<void> {
  const html = await textOf(response);
  expect(response.status).toBe(200);
  expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
  expect(html).toContain("<title>DiMascio Baseball</title>");
  expect(html).toContain('content="Private baseball lessons in Orange County."');
  expect(html).toContain('data-brand="coach"');
  for (const lesson of lessonTypes) expect(html).toContain(lesson.name);
  expect(html).toContain(`href="${COACH_LEARN_URL}"`);
  expect(html).toContain('href="/styles.css"');
  expect(html).not.toContain("/client.js");
  expect(html).not.toContain('data-brand="ballplayer"');
  expect(hasInlineStyle(html)).toBe(false);
  expect(hasInlineScript(html)).toBe(false);
  expect(findThirdPartyRisks(html, "markup").toSorted()).toEqual([
    "https://dimasciobaseball.com/",
    COACH_LEARN_URL,
    "https://schema.org",
  ]);
}

async function expectCoachNotFound(response: AnyLestoResponse): Promise<void> {
  expect(response.status).toBe(404);
  expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
  expect(await textOf(response)).toBe("Not Found");
}

describe("the coach policy", () => {
  it("is the same strict policy as Ballplayer", () => {
    expect(COACH_CONTENT_SECURITY_POLICY).toBe(BALLPLAYER_CONTENT_SECURITY_POLICY);
  });
});

describe("the coach brand in production (runtime/web-surface.ts)", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-coach-brand-"));
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

  it.each(COACH_HOSTS)("renders the coach home page on %s", async (host) => {
    await expectCoachHome(await get(app(), "/", host));
  });

  it.each(COACH_NOT_FOUND_PATHS)(
    "answers %s on the coach host with a 404 and the policy",
    async (path) => {
      await expectCoachNotFound(await get(app(), path, "dimasciobaseball.com"));
    },
  );

  it("lets the platform API through with the coach policy", async () => {
    const api = await get(app(), "/api/teams", "dimasciobaseball.com");

    expect(api.status).toBe(401);
    expect(policyOf(api)).toBe(COACH_CONTENT_SECURITY_POLICY);
  });

  it("serves a self-hosted font on the coach host", async () => {
    const font = await get(app(), "/fonts/inter-latin-wght-normal.woff2", "dimasciobaseball.com");

    expect(font.status).toBe(200);
    expect(headerNamed(font, "content-type")).toBe("font/woff2");
    expect(policyOf(font)).toBe(COACH_CONTENT_SECURITY_POLICY);
  });
});

describe("the coach brand in dev (lesto.app.ts)", () => {
  let app: App | undefined;

  function devApp(): App {
    if (app === undefined) throw new Error("dev app did not open");
    return app;
  }

  beforeAll(async () => {
    process.env["LESTO_DB"] = ":memory:";
    process.env["SNACKDAY_DEV_SIGN_IN"] = "true";
    const { default: applicationConfig } = await import("../lesto.app");
    const config = await applicationConfig();
    await registerRuntimePages(config.app);
    app = await createApp(config);
  });

  it("renders the coach home page on the dev host", async () => {
    await expectCoachHome(await get(devApp(), "/", "coach.localhost:3000"));
  });

  it.each(COACH_NOT_FOUND_PATHS)(
    "answers %s on the dev coach host with a 404 and the policy",
    async (path) => {
      await expectCoachNotFound(await get(devApp(), path, "coach.localhost:3000"));
    },
  );
});
