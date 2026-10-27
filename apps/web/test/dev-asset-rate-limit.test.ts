import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { runWithContext } from "@lesto/web";
import { beforeAll, describe, expect, it } from "vitest";

const BURST = 200;

const DEV_ASSET_PATHS = [
  "/@lesto-dev/@vite/client",
  "/@lesto-dev/client.js",
  "/@lesto-dev/styles.css",
  "/@lesto-dev/node_modules/.vite/deps/preact.js",
  "/@lesto-dev/app/islands/team-sidebar.tsx",
  "/@fs/tmp/snackday/chunk.js",
  "/@vite/client",
  "/client.js",
  "/styles.css",
] as const;

let app: App | undefined;

function devApp(): App {
  if (app === undefined) throw new Error("dev app did not open");
  return app;
}

async function burst(
  ip: string,
  request: (index: number) => readonly [method: string, path: string],
): Promise<number[]> {
  const responses = await Promise.all(
    Array.from({ length: BURST }, (_, index) =>
      runWithContext({ requestId: `${ip}-${index}`, ip }, () => {
        const [method, path] = request(index);
        return devApp().handle(method, path);
      }),
    ),
  );
  return responses.map((response) => response.status);
}

describe("dev rate limit (lesto.app.ts)", () => {
  beforeAll(async () => {
    process.env["LESTO_DB"] = ":memory:";
    const { default: applicationConfig } = await import("../lesto.app");
    app = await createApp(await applicationConfig());
  });

  it("does not count a burst of dev module and asset requests", async () => {
    const statuses = await burst("203.0.113.10", (index) => [
      "GET",
      DEV_ASSET_PATHS[index % DEV_ASSET_PATHS.length] ?? "/client.js",
    ]);
    expect(statuses).toHaveLength(BURST);
    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });

  it("still limits an API route after the asset burst from the same client", async () => {
    const ip = "203.0.113.20";
    expect(await burst(ip, () => ["GET", "/@lesto-dev/client.js"])).not.toContain(429);
    const statuses = await burst(ip, () => ["GET", "/api/teams"]);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it("still limits a page route", async () => {
    const statuses = await burst("203.0.113.30", () => ["GET", "/app"]);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it("still limits a write to a dev asset path", async () => {
    const statuses = await burst("203.0.113.40", () => ["POST", "/client.js"]);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});
