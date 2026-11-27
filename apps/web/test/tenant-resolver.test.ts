import { installSessionSchema } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { STATIC_HOST_ORGANIZATIONS, brandForHost, brandForOrganization } from "../app/brand/brand";
import { applicationMigrations } from "../app/lib/server/composition";
import {
  BALLPLAYER_ORGANIZATION_ID,
  COACH_ORGANIZATION_ID,
  SNACKDAY_ORGANIZATION_ID,
} from "../app/lib/server/organizations";
import {
  FALLBACK_ORGANIZATION_ID,
  TENANT_CACHE_TTL_MS,
  TENANT_MISS_TTL_MS,
  TenantCache,
  resolveTenant,
  tenantForHost,
  tenantResolver,
} from "../app/tenant/tenant";
import type { Tenant } from "../app/tenant/tenant";

const handles: (() => void)[] = [];

afterEach(() => {
  for (const close of handles.splice(0)) close();
});

const NOW = "2026-11-25T12:00:00.000Z";

interface Migrated {
  readonly sql: SqlDatabase;
  readonly db: Db;
}

async function migrated(): Promise<Migrated> {
  const { db: sql, close } = await openSqlite(":memory:");
  handles.push(close);
  await installSessionSchema(sql);
  await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
  return { sql, db: createDb(sql, { dialect: "sqlite" }) };
}

class FakeClock {
  time = Date.parse(NOW);

  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

async function insertHostname(
  sql: SqlDatabase,
  hostname: string,
  organizationId: string,
  status: "pending" | "active",
): Promise<void> {
  await sql
    .prepare(
      "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, cf_custom_hostname_id, is_primary, created_at, updated_at) VALUES (?, ?, 'custom', ?, NULL, 0, ?, ?)",
    )
    .run([hostname, organizationId, status, NOW, NOW]);
}

async function deleteHostname(sql: SqlDatabase, hostname: string): Promise<void> {
  await sql.prepare("DELETE FROM organization_hostnames WHERE hostname = ?").run([hostname]);
}

const SNACKDAY_TENANT: Tenant = {
  organizationId: SNACKDAY_ORGANIZATION_ID,
  slug: "snackday",
  modules: ["teams", "cards", "lessons"],
  theme: "snackday",
  primaryHost: "snackday.app",
};

const COACH_TENANT: Tenant = {
  organizationId: COACH_ORGANIZATION_ID,
  slug: "coach",
  modules: ["booking", "articles"],
  theme: "coach",
  primaryHost: "dimasciobaseball.com",
};

const BALLPLAYER_TENANT: Tenant = {
  organizationId: BALLPLAYER_ORGANIZATION_ID,
  slug: "ballplayer",
  modules: ["cards"],
  theme: "ballplayer",
  primaryHost: "ballplayer.co",
};

const SEEDED_HOSTS: readonly (readonly [string, Tenant])[] = [
  ["snackday.app", SNACKDAY_TENANT],
  ["www.snackday.app", SNACKDAY_TENANT],
  ["localhost", SNACKDAY_TENANT],
  ["127.0.0.1", SNACKDAY_TENANT],
  ["[::1]", SNACKDAY_TENANT],
  ["dimasciobaseball.com", COACH_TENANT],
  ["www.dimasciobaseball.com", COACH_TENANT],
  ["coach.localhost", COACH_TENANT],
  ["ballplayer.co", BALLPLAYER_TENANT],
  ["www.ballplayer.co", BALLPLAYER_TENANT],
  ["ballplayer.localhost", BALLPLAYER_TENANT],
];

/** The per-environment hosts PR 46 left to the fallback, plus look-alikes of seeded hosts. */
const FALLBACK_HOSTS = [
  "staging.snackday.app",
  "ci.snackday.invalid",
  "staging.snackduty.test",
  "learn.dimasciobaseball.com",
  "media.dimasciobaseball.com",
  "ballplayer.co.evil.test",
  "evil-ballplayer.co",
  "app.ballplayer.co",
  "",
];

describe("resolveTenant", () => {
  it.each(SEEDED_HOSTS)("resolves the seeded host %s to its organization", async (host, tenant) => {
    const { db } = await migrated();

    expect(await resolveTenant(db, host, new TenantCache())).toEqual(tenant);
  });

  it.each([
    ["DiMascioBaseball.COM", COACH_TENANT],
    ["dimasciobaseball.com:443", COACH_TENANT],
    ["coach.localhost:3000", COACH_TENANT],
    ["dimasciobaseball.com.", COACH_TENANT],
    [" WWW.Ballplayer.co:8443 ", BALLPLAYER_TENANT],
    ["ballplayer.co.", BALLPLAYER_TENANT],
    ["localhost:3000", SNACKDAY_TENANT],
    ["127.0.0.1:5173", SNACKDAY_TENANT],
    ["[::1]:3000", SNACKDAY_TENANT],
  ] as const)("normalizes %j before the lookup", async (host, tenant) => {
    const { db } = await migrated();

    expect(await resolveTenant(db, host, new TenantCache())).toEqual(tenant);
  });

  it("does not resolve a pending host", async () => {
    const { sql, db } = await migrated();
    await insertHostname(sql, "pending.example.test", COACH_ORGANIZATION_ID, "pending");

    expect(await resolveTenant(db, "pending.example.test", new TenantCache())).toBeUndefined();
    expect(await tenantForHost(db, "pending.example.test", new TenantCache())).toEqual(
      SNACKDAY_TENANT,
    );
  });

  it("does not resolve the host of an archived organization", async () => {
    const { sql, db } = await migrated();
    await sql
      .prepare("UPDATE organizations SET status = 'archived' WHERE id = ?")
      .run([COACH_ORGANIZATION_ID]);

    expect(await resolveTenant(db, "dimasciobaseball.com", new TenantCache())).toBeUndefined();
    expect(await tenantForHost(db, "dimasciobaseball.com", new TenantCache())).toEqual(
      SNACKDAY_TENANT,
    );
  });

  it.each(FALLBACK_HOSTS)("does not resolve the unknown host %j", async (host) => {
    const { db } = await migrated();

    expect(await resolveTenant(db, host, new TenantCache())).toBeUndefined();
  });
});

describe("the fallback", () => {
  it("is the Snackday organization", () => {
    expect(FALLBACK_ORGANIZATION_ID).toBe(SNACKDAY_ORGANIZATION_ID);
  });

  it.each([...FALLBACK_HOSTS, "staging.snackduty.test:8443"])(
    "serves the unknown host %j as Snackday",
    async (host) => {
      const { db } = await migrated();

      expect(await tenantForHost(db, host, new TenantCache())).toEqual(SNACKDAY_TENANT);
    },
  );

  it("serves a missing Host as Snackday", async () => {
    const { db } = await migrated();

    expect(await tenantForHost(db, undefined, new TenantCache())).toEqual(SNACKDAY_TENANT);
  });

  it("fails loudly when the fallback organization is archived", async () => {
    const { sql, db } = await migrated();
    await sql
      .prepare("UPDATE organizations SET status = 'archived' WHERE id = ?")
      .run([SNACKDAY_ORGANIZATION_ID]);

    await expect(tenantForHost(db, "unknown.test", new TenantCache())).rejects.toThrow(
      "The fallback organization org_snackday is missing or archived.",
    );
  });
});

describe("the tenant cache", () => {
  it("returns the same tenant without a read until the entry expires", async () => {
    const { sql, db } = await migrated();
    const clock = new FakeClock();
    const cache = new TenantCache({ now: clock.now });
    await insertHostname(sql, "club.example.test", COACH_ORGANIZATION_ID, "active");

    const first = await resolveTenant(db, "club.example.test", cache);
    await deleteHostname(sql, "club.example.test");
    clock.advance(TENANT_CACHE_TTL_MS - 1);
    const cached = await resolveTenant(db, "CLUB.example.test:443", cache);
    clock.advance(1);
    const expired = await resolveTenant(db, "club.example.test", cache);

    expect(first).toEqual(COACH_TENANT);
    expect(cached).toBe(first);
    expect(expired).toBeUndefined();
  });

  it("keeps a miss for a few seconds only", async () => {
    const { sql, db } = await migrated();
    const clock = new FakeClock();
    const cache = new TenantCache({ now: clock.now });

    expect(await resolveTenant(db, "new.example.test", cache)).toBeUndefined();
    await insertHostname(sql, "new.example.test", BALLPLAYER_ORGANIZATION_ID, "active");
    clock.advance(TENANT_MISS_TTL_MS - 1);
    expect(await resolveTenant(db, "new.example.test", cache)).toBeUndefined();
    clock.advance(1);
    expect(await resolveTenant(db, "new.example.test", cache)).toEqual(BALLPLAYER_TENANT);
    expect(TENANT_MISS_TTL_MS).toBeLessThanOrEqual(5_000);
    expect(TENANT_CACHE_TTL_MS).toBe(60_000);
  });

  it("holds at most its bound and drops the oldest host first", async () => {
    const { db } = await migrated();
    const cache = new TenantCache({ maxEntries: 2 });

    await resolveTenant(db, "snackday.app", cache);
    await resolveTenant(db, "ballplayer.co", cache);
    await resolveTenant(db, "dimasciobaseball.com", cache);

    expect(cache.size).toBe(2);
    expect(cache.peek("snackday.app")).toBeUndefined();
    expect(cache.peek("dimasciobaseball.com")?.value).toEqual(COACH_TENANT);
  });
});

describe("tenantResolver", () => {
  it("reads only the Host header", async () => {
    const { db } = await migrated();
    const tenants = tenantResolver(db, new TenantCache());

    expect(await tenants.resolve({ host: "ballplayer.co" })).toEqual(BALLPLAYER_TENANT);
    expect(await tenants.resolve({ "x-forwarded-host": "ballplayer.co" })).toEqual(SNACKDAY_TENANT);
    expect(
      await tenants.resolve({ host: "snackday.app", "x-forwarded-host": "ballplayer.co" }),
    ).toEqual(SNACKDAY_TENANT);
    expect(await tenants.resolve(undefined)).toEqual(SNACKDAY_TENANT);
  });

  it("peeks only at what resolve answered, and never reads", async () => {
    const { sql, db } = await migrated();
    const clock = new FakeClock();
    const tenants = tenantResolver(db, new TenantCache({ now: clock.now }));

    expect(tenants.peek({ host: "dimasciobaseball.com" })).toBeUndefined();
    const coach = await tenants.resolve({ host: "dimasciobaseball.com" });
    await tenants.resolve({ host: "unknown.example.test" });
    await sql.exec("DROP TABLE organization_hostnames");
    clock.advance(TENANT_CACHE_TTL_MS);

    expect(tenants.peek({ host: "DiMascioBaseball.com:443" })).toBe(coach);
    expect(tenants.peek({ host: "unknown.example.test" })).toEqual(SNACKDAY_TENANT);
    expect(tenants.peek({ host: "ballplayer.co" })).toBeUndefined();
  });
});

describe("the brand shim", () => {
  it.each(SEEDED_HOSTS)("gives %s the same brand from the table and from code", async (host) => {
    const { db } = await migrated();
    const tenant = await tenantForHost(db, host, new TenantCache());

    expect(brandForOrganization(tenant.organizationId)).toBe(brandForHost(host));
  });

  it.each(FALLBACK_HOSTS)("gives the fallback host %j the Snackday brand", async (host) => {
    const { db } = await migrated();
    const tenant = await tenantForHost(db, host, new TenantCache());

    expect(brandForOrganization(tenant.organizationId)).toBe("snackday");
    expect(brandForHost(host)).toBe("snackday");
  });

  it("maps each seeded organization to today's brand", () => {
    expect(brandForOrganization(SNACKDAY_ORGANIZATION_ID)).toBe("snackday");
    expect(brandForOrganization(COACH_ORGANIZATION_ID)).toBe("coach");
    expect(brandForOrganization(BALLPLAYER_ORGANIZATION_ID)).toBe("ballplayer");
    expect(brandForOrganization("org_new_league")).toBe("snackday");
  });

  it("keeps the static host map equal to the active hostname rows of a new database", async () => {
    const { sql } = await migrated();
    const rows = (await sql
      .prepare(
        "SELECT hostname, organization_id FROM organization_hostnames WHERE status = 'active' ORDER BY hostname",
      )
      .all([])) as { hostname: string; organization_id: string }[];

    expect(rows.map((row) => [row.hostname, row.organization_id])).toEqual(
      [...STATIC_HOST_ORGANIZATIONS].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
});
