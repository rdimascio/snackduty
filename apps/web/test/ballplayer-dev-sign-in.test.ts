import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import type { AnyLestoResponse } from "@lesto/web";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ballplayerHome } from "../app/ballplayer/home-page";
import { applySeed } from "../app/dev/seed-database";
import { SEED_CHILDREN, seedPersona } from "../app/dev/seed-personas";
import { registerDevSignIn } from "../app/dev/sign-in";
import { BALLPLAYER_DEV_PERSONAS, signInAs } from "../app/islands/ballplayer-session";
import { staticLessonCatalog } from "../app/lessons/catalog";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { routeBrands, secureBrands } from "../app/server/brand-routing";
import { registerRuntimePages } from "../runtime/web-surface";

const BALLPLAYER_HOST = "ballplayer.localhost:3000";
const sameOrigin = { "sec-fetch-site": "same-origin" };

const opened = await openSqlite(":memory:");
const services = await identityServices(opened.db, { mode: "development", clock: Date.now });
const { config } = createApplication({
  sql: opened.db,
  db: services.db,
  sessions: services.sessions,
  mode: "development",
  clock: Date.now,
  developmentSignIn: true,
  inviteDelivery: devInviteDeliverer(),
  lessons: { enabled: true, catalog: staticLessonCatalog([]) },
});
const signedIn = registerDevSignIn(config.app, {
  enabled: true,
  db: services.db,
  sessions: services.sessions,
});
const branded = routeBrands(signedIn, { home: ballplayerHome });
await registerRuntimePages(branded);
const app: App = await createApp({ ...config, app: secureBrands(branded) });
await applySeed(opened.db);

afterAll(() => opened.close());

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function header(response: AnyLestoResponse, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function cardLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="Player card for ([^"]+)"/gu)].map(([, name]) => name ?? "");
}

const realFetch = globalThis.fetch;
let jar = "";

beforeEach(() => {
  jar = "";
  globalThis.fetch = Object.assign(
    async (url: string, init: RequestInit = {}) => {
      const response = await app.handle(init.method ?? "GET", url, {
        headers: { ...sameOrigin, host: BALLPLAYER_HOST },
        ...(typeof init.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      jar = header(response, "set-cookie").split(";", 1)[0] ?? "";
      return new Response(await textOf(response), { status: response.status });
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the Ballplayer dev sign-in against the SQL seed", () => {
  it("offers only seeded guardian and coach personas", () => {
    expect(BALLPLAYER_DEV_PERSONAS.map(({ persona }) => persona).toSorted()).toEqual([
      "co-coach",
      "head-coach",
      "parent",
    ]);
  });

  for (const { persona } of BALLPLAYER_DEV_PERSONAS) {
    it(`signs in ${persona} on the Ballplayer host and shows a filled card`, async () => {
      expect(await signInAs(persona)).toEqual({ state: "working" });
      expect(jar).toMatch(/^snackday_session_dev=./u);

      const response = await app.handle("GET", "/app", {
        headers: { host: BALLPLAYER_HOST, cookie: jar },
      });
      const html = await textOf(response);

      expect(response.status).toBe(200);
      expect(html).toContain(seedPersona(persona)?.displayName ?? persona);
      expect(cardLabels(html)).toContain(SEED_CHILDREN.avery.displayName);
      expect(html).toContain("7-day streak");
      expect(html).not.toContain("No player cards yet");
    });
  }
});
