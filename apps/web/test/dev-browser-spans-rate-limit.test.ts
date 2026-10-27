import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { dispatchSitesDev, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";

const BURST = 300;
const QUIET = { host: "127.0.0.1", port: 0, logRequest: () => {} };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const SPAN_BATCH = JSON.stringify({ v: 1, traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spans: [] });

async function burst(origin: string, send: (url: string) => Promise<Response>): Promise<number[]> {
  const responses = await Promise.all(Array.from({ length: BURST }, () => send(origin)));
  return responses.map((response) => response.status);
}

function postBrowserSpans(origin: string): Promise<Response> {
  return fetch(`${origin}/__lesto/browser-spans`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, "content-type": "application/json" },
    body: SPAN_BATCH,
  });
}

function getTeams(origin: string): Promise<Response> {
  return fetch(`${origin}/api/teams`, { headers: SAME_ORIGIN });
}

function count(statuses: readonly number[], status: number): number {
  return statuses.filter((value) => value === status).length;
}

async function devServer(): Promise<Server> {
  process.env["LESTO_DB"] = ":memory:";
  const { default: applicationConfig } = await import("../lesto.app");
  const app = await createApp(await applicationConfig());
  const handle = dispatchSitesDev({
    sites: [{ name: "app", render: "dynamic", basePath: "/" }],
    handle: (method, path, options) => app.handle(method, path, options),
  });
  const devApp: App = { handle, migrationsApplied: app.migrationsApplied };
  return serve(devApp, QUIET);
}

describe("browser span posts and the rate limiter", () => {
  let dev: Server | undefined;
  let staging: Server | undefined;
  let runtime: RuntimeApplication | undefined;
  let scratch: string | undefined;

  function originOf(server: Server | undefined): string {
    if (server === undefined) throw new Error("server did not start");
    return `http://127.0.0.1:${server.port}`;
  }

  beforeAll(async () => {
    dev = await devServer();
    scratch = await mkdtemp(join(tmpdir(), "snackday-browser-spans-"));
    runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL("https://staging.snackduty.test"),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
    staging = await serve(runtime.app, QUIET);
  });

  afterAll(async () => {
    await dev?.close();
    await staging?.close();
    await runtime?.close();
    if (scratch !== undefined) await rm(scratch, { recursive: true });
  });

  it("accepts a burst of browser span posts in development", async () => {
    const statuses = await burst(originOf(dev), postBrowserSpans);
    expect(count(statuses, 429)).toBe(0);
    expect(count(statuses, 204)).toBe(BURST);
  }, 30_000);

  it("still limits other development requests from the same client", async () => {
    const statuses = await burst(originOf(dev), getTeams);
    expect(count(statuses, 429)).toBeGreaterThan(0);
  }, 30_000);

  it("still limits the same burst of browser span posts in staging", async () => {
    const statuses = await burst(originOf(staging), postBrowserSpans);
    expect(count(statuses, 429)).toBeGreaterThan(0);
  }, 30_000);
});
