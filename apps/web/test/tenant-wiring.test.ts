import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { SqlDatabase } from "@lesto/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { COACH_ORGANIZATION_ID } from "../app/lib/server/organizations";
import { openRuntimeDatabase } from "../runtime";
import { registerRuntimePages } from "../runtime/web-surface";
import {
  SNACKDAY_POLICY,
  STRICT_POLICY,
  addHostname,
  countingHostnameReads,
  headerNamed,
  markHostnamePending,
  markerOf,
  openRuntimeFixture,
  textOf,
  withHost,
} from "./support/tenant-fixture";
import type { RuntimeFixture } from "./support/tenant-fixture";

const DATABASE_ONLY_HOST = "club.example.test";

const PENDING_COACH_HOST = "www.dimasciobaseball.com";

const COACH_HOME = "title=DiMascio Baseball brand=coach";

const SNACKDAY_HOME = "title=Snackday — youth sports, minus the chaos brand=none";

async function seedTenantRows(sql: SqlDatabase): Promise<void> {
  await addHostname(sql, DATABASE_ONLY_HOST, COACH_ORGANIZATION_ID);
  await markHostnamePending(sql, PENDING_COACH_HOST);
}

async function page(app: App, path: string, host: string) {
  const response = await app.handle("GET", path, withHost(host));
  return {
    status: response.status,
    policy: headerNamed(response, "content-security-policy"),
    marker: markerOf(await textOf(response)),
  };
}

/** Rows only the database knows: the static host map would answer Snackday and coach. */
function describeTenantRows(
  label: string,
  open: () => Promise<{ app: App; close(): Promise<void> }>,
) {
  describe(`${label} on rows only the database has`, () => {
    let opened: { app: App; close(): Promise<void> } | undefined;

    function app(): App {
      if (opened === undefined) throw new Error(`${label} did not open`);
      return opened.app;
    }

    beforeAll(async () => {
      opened = await open();
    });

    afterAll(async () => {
      await opened?.close();
    });

    it("serves an active database-only host as the coach site", async () => {
      expect(await page(app(), "/", DATABASE_ONLY_HOST)).toEqual({
        status: 200,
        policy: STRICT_POLICY,
        marker: COACH_HOME,
      });
      expect(await page(app(), "/book", DATABASE_ONLY_HOST)).toEqual({
        status: 200,
        policy: STRICT_POLICY,
        marker: "title=Request a lesson | DiMascio Baseball brand=coach",
      });
      expect(await page(app(), "/app", DATABASE_ONLY_HOST)).toEqual({
        status: 404,
        policy: STRICT_POLICY,
        marker: "Not Found",
      });
    });

    it("serves a pending coach host as Snackday", async () => {
      expect(await page(app(), "/", PENDING_COACH_HOST)).toEqual({
        status: 200,
        policy: SNACKDAY_POLICY,
        marker: SNACKDAY_HOME,
      });
      expect(await page(app(), "/book", PENDING_COACH_HOST)).toEqual({
        status: 404,
        policy: SNACKDAY_POLICY,
        marker: "Not Found",
      });
    });
  });
}

describeTenantRows("the runtime (runtime/application.ts)", async () => {
  const fixture = await openRuntimeFixture();
  await seedTenantRows(fixture.runtime.sql);
  return { app: fixture.runtime.app, close: () => fixture.close() };
});

describeTenantRows("dev (lesto.app.ts)", async () => {
  process.env["LESTO_DB"] = ":memory:";
  const { default: applicationConfig } = await import("../lesto.app");
  const config = await applicationConfig();
  await registerRuntimePages(config.app);
  const app = await createApp(config);
  await seedTenantRows(config.db);
  return { app, close: () => Promise.resolve() };
});

describe("the origin check on a tenant host", () => {
  let fixture: RuntimeFixture | undefined;

  async function post(headers: Record<string, string>): Promise<number> {
    if (fixture === undefined) throw new Error("runtime did not open");
    const response = await fixture.runtime.app.handle("POST", "/api/teams", {
      ...withHost("dimasciobaseball.com", headers),
      body: { name: "Origin probe" },
    });
    return response.status;
  }

  beforeAll(async () => {
    fixture = await openRuntimeFixture();
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("admits same-origin and same-site requests, which then need a session", async () => {
    expect(await post({ "sec-fetch-site": "same-origin" })).toBe(401);
    expect(await post({ "sec-fetch-site": "same-site" })).toBe(401);
  });

  it("refuses a cross-site request", async () => {
    expect(await post({ "sec-fetch-site": "cross-site" })).toBe(403);
  });

  it("refuses a same-host Origin with no Sec-Fetch-Site, because the allow list is empty", async () => {
    expect(await post({ origin: "https://dimasciobaseball.com" })).toBe(403);
  });
});

describe("tenant reads and kernel admission", () => {
  let fixture: RuntimeFixture | undefined;
  let reads: (() => number) | undefined;

  function hostnameReads(): number {
    if (reads === undefined) throw new Error("runtime did not open");
    return reads();
  }

  beforeAll(async () => {
    fixture = await openRuntimeFixture({
      openDatabase: async (target) => {
        const database = await openRuntimeDatabase(target);
        const counted = countingHostnameReads(database.sql);
        reads = counted.count;
        return { ...database, sql: counted.sql };
      },
    });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("runs no hostname query for a request the origin check refuses, and keeps its policy", async () => {
    if (fixture === undefined) throw new Error("runtime did not open");
    const before = hostnameReads();
    const response = await fixture.runtime.app.handle("POST", "/api/teams", {
      ...withHost("dimasciobaseball.com", { "sec-fetch-site": "cross-site" }),
      body: { name: "Refused" },
    });

    expect(response.status).toBe(403);
    expect(headerNamed(response, "content-security-policy")).toBe(STRICT_POLICY);
    expect(hostnameReads()).toBe(before);
  });

  it("reads the hostname table for an admitted request", async () => {
    if (fixture === undefined) throw new Error("runtime did not open");
    const before = hostnameReads();
    const response = await fixture.runtime.app.handle("GET", "/", withHost("ballplayer.co"));

    expect(response.status).toBe(200);
    expect(hostnameReads()).toBeGreaterThan(before);
  });
});

describe("a tenant read that fails", () => {
  let fixture: RuntimeFixture | undefined;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeAll(async () => {
    fixture = await openRuntimeFixture();
    await fixture.runtime.sql.exec("DROP TABLE organization_hostnames");
    errors.mockClear();
  });

  afterAll(async () => {
    errors.mockRestore();
    await fixture?.close();
  });

  it("serves what the static host map gives and logs one event with no host", async () => {
    if (fixture === undefined) throw new Error("runtime did not open");

    expect(await page(fixture.runtime.app, "/", "dimasciobaseball.com")).toEqual({
      status: 200,
      policy: STRICT_POLICY,
      marker: COACH_HOME,
    });
    const asset = await fixture.runtime.app.handle(
      "GET",
      "/styles.css",
      withHost("dimasciobaseball.com"),
    );
    expect(headerNamed(asset, "content-security-policy")).toBe(STRICT_POLICY);
    expect(errors.mock.calls).toEqual([
      [JSON.stringify({ level: "error", event: "tenant.resolve_failed" })],
    ]);
  });
});
