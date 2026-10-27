import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accounts, people, VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
import { SNACKDAY_CONTENT_SECURITY_POLICY } from "../app/server/content-security-policy";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import { registerRuntimePages } from "../runtime/web-surface";

const REACT_PROGRESSIVE_CHUNK_SIZE = 12_800;
const ROSTER_SIZE = 60;
const HOST = "staging.snackduty.test";
const PERSON_ID = "person_stream_probe";
const ACCOUNT_ID = "account_stream_probe";
const TEAM_NAME = "Stream Outline Falcons";
const NOW = "2026-10-26T12:00:00.000Z";
const LOADING_SKELETON = 'aria-busy="true"';
const REACT_REVEAL_MARKERS = ["$RC", "$RS", "$RX", "<template", "<!--$?-->"];

function playerName(index: number): string {
  return `Outline Player ${String(index + 1).padStart(3, "0")}`;
}

function withHost(extra: Record<string, string> = {}): HandleOptions {
  return { headers: { host: HOST, ...extra } };
}

function mutation(cookie: string): HandleOptions {
  return withHost({ cookie, "sec-fetch-site": "same-origin" });
}

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function policyOf(response: AnyLestoResponse): unknown {
  return Object.entries(response.headers).find(
    ([header]) => header.toLowerCase() === "content-security-policy",
  )?.[1];
}

function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/giu)].flatMap(([tag, attributes]) =>
    /\bsrc=/iu.test(attributes ?? "") || /\btype="application\/json"/iu.test(attributes ?? "")
      ? []
      : [tag],
  );
}

function routeContentOf(html: string): string {
  const start = html.indexOf("<main");
  const end = html.lastIndexOf("</main>");
  if (start === -1 || end === -1) throw new Error("the page has no <main> element");
  return html.slice(start, end);
}

async function seedLargeRoster(app: App, cookie: string): Promise<void> {
  const team = await app.handle("POST", "/api/teams", {
    ...mutation(cookie),
    body: { name: TEAM_NAME },
  });
  expect(team.status).toBe(201);
  const teamId = (JSON.parse(await textOf(team)) as { team: { id: string } }).team.id;
  const season = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    ...mutation(cookie),
    body: {
      label: "Outline season",
      startDate: "2026-09-01",
      endDate: "2027-03-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(season.status).toBe(201);
  const seasonId = (JSON.parse(await textOf(season)) as { season: { id: string } }).season.id;
  for (let index = 0; index < ROSTER_SIZE; index += 1) {
    const player = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        ...mutation(cookie),
        body: { displayName: playerName(index), birthDate: "2018-04-09" },
      },
    );
    expect(player.status).toBe(201);
  }
}

async function signInProbe(
  db: RuntimeApplication["db"],
  sessions: RuntimeApplication["sessions"],
): Promise<string> {
  await db
    .insert(people)
    .values({
      id: PERSON_ID,
      displayName: "Stream Probe Adult",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  await db
    .insert(accounts)
    .values({
      id: ACCOUNT_ID,
      personId: PERSON_ID,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const session = await sessions.create(ACCOUNT_ID, 60_000);
  return `${VERIFIED_SESSION_COOKIE}=${session.token}`;
}

function expectCompleteInlineRender(html: string): void {
  expect(routeContentOf(html).length).toBeGreaterThan(REACT_PROGRESSIVE_CHUNK_SIZE);
  expect(html).toContain(TEAM_NAME);
  for (let index = 0; index < ROSTER_SIZE; index += 1) {
    expect(html).toContain(playerName(index));
  }
  expect(html).not.toContain(LOADING_SKELETON);
  for (const marker of REACT_REVEAL_MARKERS) expect(html).not.toContain(marker);
  expect(executableInlineScripts(html)).toEqual([]);
}

describe("a route larger than React's progressive chunk size in production", () => {
  let scratch = "";
  let runtime: RuntimeApplication | undefined;
  let cookie = "";

  function app(): App {
    if (runtime === undefined) throw new Error("runtime did not open");
    return runtime.app;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "snackday-stream-csp-"));
    runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL(`https://${HOST}`),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
    cookie = await signInProbe(runtime.db, runtime.sessions);
    await seedLargeRoster(runtime.app, cookie);
  });

  afterAll(async () => {
    await runtime?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it("renders /app in document order with no reveal script under the strict policy", async () => {
    const response = await app().handle("GET", "/app", withHost({ cookie }));
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(SNACKDAY_CONTENT_SECURITY_POLICY);
    expectCompleteInlineRender(html);
  });
});

describe("a route larger than React's progressive chunk size in dev", () => {
  let app: App | undefined;
  let cookie = "";

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
    const signIn = await app.handle("POST", "/api/dev/sign-in", {
      ...withHost({ "sec-fetch-site": "same-origin" }),
      body: { persona: "default" },
    });
    expect(signIn.status).toBe(200);
    const setCookie = Object.entries(signIn.headers).find(
      ([header]) => header.toLowerCase() === "set-cookie",
    )?.[1];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = String(first).split(";")[0] ?? "";
    await seedLargeRoster(app, cookie);
  });

  it("renders /app in document order with no reveal script under the strict policy", async () => {
    const response = await devApp().handle("GET", "/app", withHost({ cookie }));
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(SNACKDAY_CONTENT_SECURITY_POLICY);
    expectCompleteInlineRender(html);
  });
});
