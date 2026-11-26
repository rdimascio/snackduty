import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installSessionSchema } from "@lesto/auth";
import type { SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { SEED_DIRECTORY, seedFiles } from "../app/dev/seed-database";
import { SEED_TEAMS } from "../app/dev/seed-personas";
import { applicationMigrations } from "../app/lib/server/composition";
import {
  BALLPLAYER_ORGANIZATION_ID,
  COACH_ORGANIZATION_ID,
  createOrganizations,
  SNACKDAY_ORGANIZATION_ID,
  TEAMS_ORGANIZATION_INDEX,
} from "../app/lib/server/organizations";

const handles: (() => void)[] = [];

afterEach(() => {
  for (const close of handles.splice(0)) close();
});

const NOW = "2026-11-25T12:00:00.000Z";
const OWNER = "person_org_owner";
const LEGACY_TEAMS = ["team_org_legacy_a", "team_org_legacy_b", "team_org_legacy_unused"];

async function rows<T>(sql: SqlDatabase, query: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.prepare(query).all(params)) as T[];
}

async function openDatabase(): Promise<SqlDatabase> {
  const { db, close } = await openSqlite(":memory:");
  handles.push(close);
  await installSessionSchema(db);
  return db;
}

function migrateAll(sql: SqlDatabase): Promise<string[]> {
  return new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
}

async function migrated(): Promise<SqlDatabase> {
  const sql = await openDatabase();
  await migrateAll(sql);
  await insertOwner(sql);
  return sql;
}

async function insertOwner(sql: SqlDatabase): Promise<void> {
  await sql
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, 'Org owner', 'active', ?, ?)",
    )
    .run([OWNER, NOW, NOW]);
}

/** A database on the last schema before organizations, holding teams and a season per used team. */
async function teamsBeforeOrganizations(): Promise<SqlDatabase> {
  const sql = await openDatabase();
  const before = applicationMigrations.filter(
    (migration) => migration.version !== createOrganizations.version,
  );
  await new Migrator(sql, before, { dialect: "sqlite" }).migrate();
  await insertOwner(sql);
  for (const teamId of LEGACY_TEAMS) {
    await sql
      .prepare(
        "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES (?, 'Legacy team', 'active', ?, ?, ?)",
      )
      .run([teamId, OWNER, NOW, NOW]);
  }
  for (const teamId of LEGACY_TEAMS.slice(0, 2)) {
    await sql
      .prepare(
        "INSERT INTO seasons (id, team_id, label, start_date, end_date, time_zone, status, created_at, updated_at) VALUES (?, ?, 'Fall', '2026-09-01', '2026-12-01', 'UTC', 'active', ?, ?)",
      )
      .run([`season_${teamId}`, teamId, NOW, NOW]);
  }
  return sql;
}

async function insertTeam(sql: SqlDatabase, id: string, organizationId: string | null) {
  await sql
    .prepare(
      "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at, organization_id) VALUES (?, 'New team', 'active', ?, ?, ?, ?)",
    )
    .run([id, OWNER, NOW, NOW, organizationId]);
}

async function columnNames(sql: SqlDatabase, table: string): Promise<string[]> {
  return (await rows<{ name: string }>(sql, `PRAGMA table_info(${table})`)).map((row) => row.name);
}

async function insertHost(
  sql: SqlDatabase,
  hostname: string,
  status: string,
  isPrimary: number,
  organizationId: string = SNACKDAY_ORGANIZATION_ID,
) {
  await sql
    .prepare(
      "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, is_primary, created_at, updated_at) VALUES (?, ?, 'subdomain', ?, ?, ?, ?)",
    )
    .run([hostname, organizationId, status, isPrimary, NOW, NOW]);
}

/** SQLite has no foreign key on `teams.organization_id`, so this is the check that every team's organization exists. */
async function teamsWithoutOrganization(sql: SqlDatabase): Promise<unknown[]> {
  return rows(
    sql,
    "SELECT teams.id FROM teams LEFT JOIN organizations ON organizations.id = teams.organization_id WHERE organizations.id IS NULL",
  );
}

async function indexNames(sql: SqlDatabase, table: string): Promise<string[]> {
  return (await rows<{ name: string }>(sql, `PRAGMA index_list(${table})`))
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_autoindex_"))
    .toSorted();
}

describe("the organizations migration", () => {
  it("puts every existing team in the snackday organization and keeps its children", async () => {
    const sql = await teamsBeforeOrganizations();

    expect(await migrateAll(sql)).toEqual([createOrganizations.version]);

    expect(await rows(sql, "SELECT id, organization_id FROM teams ORDER BY id")).toEqual(
      LEGACY_TEAMS.toSorted().map((id) => ({ id, organization_id: SNACKDAY_ORGANIZATION_ID })),
    );
    expect(await rows(sql, "SELECT id, team_id FROM seasons ORDER BY id")).toEqual(
      LEGACY_TEAMS.slice(0, 2).map((teamId) => ({ id: `season_${teamId}`, team_id: teamId })),
    );
    expect(await rows(sql, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await teamsWithoutOrganization(sql)).toEqual([]);
    expect(await indexNames(sql, "teams")).toEqual([
      "teams_created_by_person_id_idx",
      TEAMS_ORGANIZATION_INDEX,
    ]);
  });

  it("puts a team the previous release inserts without organization_id in snackday", async () => {
    const sql = await migrated();
    await sql
      .prepare(
        "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES ('team_previous_release', 'Old release team', 'active', ?, ?, ?)",
      )
      .run([OWNER, NOW, NOW]);

    expect(
      await rows(sql, "SELECT organization_id FROM teams WHERE id = 'team_previous_release'"),
    ).toEqual([{ organization_id: SNACKDAY_ORGANIZATION_ID }]);
    expect(await teamsWithoutOrganization(sql)).toEqual([]);
  });

  it("seeds the three organizations with their modules and hosts", async () => {
    const sql = await migrated();

    expect(
      await rows(
        sql,
        "SELECT id, slug, name, kind, status, theme, logo_key FROM organizations ORDER BY id",
      ),
    ).toEqual([
      {
        id: BALLPLAYER_ORGANIZATION_ID,
        slug: "ballplayer",
        name: "Ballplayer",
        kind: "club",
        status: "active",
        theme: "ballplayer",
        logo_key: null,
      },
      {
        id: COACH_ORGANIZATION_ID,
        slug: "coach",
        name: "DiMascio Baseball",
        kind: "coach",
        status: "active",
        theme: "coach",
        logo_key: null,
      },
      {
        id: SNACKDAY_ORGANIZATION_ID,
        slug: "snackday",
        name: "Snackday",
        kind: "club",
        status: "active",
        theme: "snackday",
        logo_key: null,
      },
    ]);
    expect(
      await rows(
        sql,
        "SELECT organization_id, module FROM organization_modules ORDER BY organization_id, module",
      ),
    ).toEqual([
      { organization_id: BALLPLAYER_ORGANIZATION_ID, module: "cards" },
      { organization_id: COACH_ORGANIZATION_ID, module: "articles" },
      { organization_id: COACH_ORGANIZATION_ID, module: "booking" },
      { organization_id: SNACKDAY_ORGANIZATION_ID, module: "cards" },
      { organization_id: SNACKDAY_ORGANIZATION_ID, module: "lessons" },
      { organization_id: SNACKDAY_ORGANIZATION_ID, module: "teams" },
    ]);
    expect(
      await rows(
        sql,
        "SELECT hostname, organization_id, kind, status, cf_custom_hostname_id, is_primary FROM organization_hostnames ORDER BY hostname",
      ),
    ).toEqual(
      [
        ["127.0.0.1", SNACKDAY_ORGANIZATION_ID, 0],
        ["[::1]", SNACKDAY_ORGANIZATION_ID, 0],
        ["ballplayer.co", BALLPLAYER_ORGANIZATION_ID, 1],
        ["ballplayer.localhost", BALLPLAYER_ORGANIZATION_ID, 0],
        ["coach.localhost", COACH_ORGANIZATION_ID, 0],
        ["dimasciobaseball.com", COACH_ORGANIZATION_ID, 1],
        ["localhost", SNACKDAY_ORGANIZATION_ID, 0],
        ["snackday.app", SNACKDAY_ORGANIZATION_ID, 1],
        ["www.ballplayer.co", BALLPLAYER_ORGANIZATION_ID, 0],
        ["www.dimasciobaseball.com", COACH_ORGANIZATION_ID, 0],
        ["www.snackday.app", SNACKDAY_ORGANIZATION_ID, 0],
      ].map(([hostname, organizationId, primary]) => ({
        hostname,
        organization_id: organizationId,
        kind: "custom",
        status: "active",
        cf_custom_hostname_id: null,
        is_primary: primary,
      })),
    );
    expect(await rows(sql, "SELECT COUNT(*) AS count FROM organization_memberships")).toEqual([
      { count: 0 },
    ]);
  });

  it("puts the dev seed teams in the snackday organization", async () => {
    const sql = await openDatabase();
    await migrateAll(sql);
    await sql.exec("PRAGMA ignore_check_constraints = ON");
    for (const file of await seedFiles()) await sql.exec(await readFile(file, "utf8"));

    expect(await rows(sql, "SELECT id, organization_id FROM teams ORDER BY id")).toEqual(
      [SEED_TEAMS.coached.teamId, SEED_TEAMS.second.teamId]
        .toSorted()
        .map((id) => ({ id, organization_id: SNACKDAY_ORGANIZATION_ID })),
    );
    expect(await teamsWithoutOrganization(sql)).toEqual([]);
  });

  it("names SNACKDAY_ORGANIZATION_ID on every seed team row, not only through the column default", async () => {
    const seed = await readFile(join(SEED_DIRECTORY, "002_teams.sql"), "utf8");
    const statement = /INSERT INTO teams \(([^)]*)\) VALUES\n([\s\S]*?);/u.exec(seed);
    const columns = statement?.[1]?.split(", ") ?? [];
    const valueRows = statement?.[2]?.split("\n") ?? [];

    expect(columns.at(-1)).toBe("organization_id");
    expect(valueRows).toHaveLength(2);
    for (const valueRow of valueRows) {
      expect(valueRow).toMatch(new RegExp(`, '${SNACKDAY_ORGANIZATION_ID}'\\),?$`, "u"));
    }
  });

  it("rolls back to the earlier teams table with every team kept", async () => {
    const sql = await teamsBeforeOrganizations();
    await migrateAll(sql);

    expect(await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).rollback()).toBe(
      createOrganizations.version,
    );

    expect(await columnNames(sql, "teams")).toEqual([
      "id",
      "name",
      "status",
      "created_by_person_id",
      "created_at",
      "updated_at",
    ]);
    expect(await rows(sql, "SELECT id FROM teams ORDER BY id")).toEqual(
      LEGACY_TEAMS.toSorted().map((id) => ({ id })),
    );
    expect(await indexNames(sql, "teams")).toEqual(["teams_created_by_person_id_idx"]);
    expect(
      await rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'organization%'",
      ),
    ).toEqual([]);
    expect(await rows(sql, "PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("the organization constraints", () => {
  it("refuse a team without an organization", async () => {
    const sql = await migrated();
    await expect(insertTeam(sql, "team_no_org", null)).rejects.toThrow(
      /NOT NULL constraint failed: teams\.organization_id/u,
    );
  });

  it("have no foreign key on SQLite, so the orphan check is what finds an unknown organization", async () => {
    const sql = await migrated();
    await insertTeam(sql, "team_unknown_org", "org_missing");
    expect(await teamsWithoutOrganization(sql)).toEqual([{ id: "team_unknown_org" }]);
  });

  it("accept a team in the snackday organization", async () => {
    const sql = await migrated();
    await insertTeam(sql, "team_snackday", SNACKDAY_ORGANIZATION_ID);
    expect(await rows(sql, "SELECT organization_id FROM teams")).toEqual([
      { organization_id: SNACKDAY_ORGANIZATION_ID },
    ]);
  });

  it("refuse an organization kind outside league, club and coach", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_bad', 'bad', 'Bad', 'school', 'snackday', ?, ?)",
        )
        .run([NOW, NOW]),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("refuse a second organization with the same slug", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_copy', 'snackday', 'Copy', 'club', 'snackday', ?, ?)",
        )
        .run([NOW, NOW]),
    ).rejects.toThrow(/UNIQUE constraint failed: organizations\.slug/u);
  });

  it("default a new organization to active", async () => {
    const sql = await migrated();
    await sql
      .prepare(
        "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_league', 'league', 'League', 'league', 'snackday', ?, ?)",
      )
      .run([NOW, NOW]);
    expect(await rows(sql, "SELECT status FROM organizations WHERE id = 'org_league'")).toEqual([
      { status: "active" },
    ]);
  });

  it("refuse a module outside the known set", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organization_modules (organization_id, module) VALUES (?, 'payments')",
        )
        .run([SNACKDAY_ORGANIZATION_ID]),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("refuse a second primary host for one organization", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, is_primary, created_at, updated_at) VALUES ('teams.snackday.app', ?, 'subdomain', 'active', 1, ?, ?)",
        )
        .run([SNACKDAY_ORGANIZATION_ID, NOW, NOW]),
    ).rejects.toThrow(/UNIQUE constraint failed: organization_hostnames\.organization_id/u);
  });

  it("accept a second host that is not primary", async () => {
    const sql = await migrated();
    await sql
      .prepare(
        "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, created_at, updated_at) VALUES ('teams.snackday.app', ?, 'subdomain', 'pending', ?, ?)",
      )
      .run([SNACKDAY_ORGANIZATION_ID, NOW, NOW]);
    expect(
      await rows(
        sql,
        "SELECT is_primary FROM organization_hostnames WHERE hostname = 'teams.snackday.app'",
      ),
    ).toEqual([{ is_primary: 0 }]);
  });

  it.each([
    ["not lower case", "Teams.Snackday.App"],
    ["empty", ""],
    ["with a port", "teams.snackday.app:3000"],
    ["an IPv6 literal with a port", "[::1]:3000"],
    ["with a space", "teams snackday.app"],
    ["with a tab", "teams.snackday.app\t"],
    ["with a trailing dot", "teams.snackday.app."],
  ])("refuse a host name that is %s", async (_rule, hostname) => {
    const sql = await migrated();
    await expect(insertHost(sql, hostname, "active", 0)).rejects.toThrow(
      /CHECK constraint failed/u,
    );
  });

  it("accept a bracketed IPv6 literal", async () => {
    const sql = await migrated();
    await insertHost(sql, "[fe80::1]", "active", 0);
    expect(
      await rows(sql, "SELECT hostname FROM organization_hostnames WHERE hostname = '[fe80::1]'"),
    ).toEqual([{ hostname: "[fe80::1]" }]);
  });

  it("refuse a pending host as primary", async () => {
    const sql = await migrated();
    await sql
      .prepare(
        "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_no_primary', 'no-primary', 'No primary', 'league', 'snackday', ?, ?)",
      )
      .run([NOW, NOW]);
    await expect(
      insertHost(sql, "pending.example.test", "pending", 1, "org_no_primary"),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await insertHost(sql, "pending.example.test", "active", 1, "org_no_primary");
  });

  it("refuse a removed host status, because removing a domain deletes its row", async () => {
    const sql = await migrated();
    await expect(insertHost(sql, "gone.example.test", "removed", 0)).rejects.toThrow(
      /CHECK constraint failed/u,
    );
  });

  it("refuse an organization slug that is not lower case", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_upper', 'Upper', 'Upper', 'club', 'snackday', ?, ?)",
        )
        .run([NOW, NOW]),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("refuse a second active admin membership for one person, but not an ended one", async () => {
    const sql = await migrated();
    const insertMembership = (id: string, status: string) =>
      sql
        .prepare(
          "INSERT INTO organization_memberships (id, organization_id, person_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)",
        )
        .run([id, SNACKDAY_ORGANIZATION_ID, OWNER, status, NOW, NOW]);

    await insertMembership("organization_membership_ended", "ended");
    await insertMembership("organization_membership_active", "active");
    await expect(insertMembership("organization_membership_twice", "active")).rejects.toThrow(
      /UNIQUE constraint failed/u,
    );
  });

  it("refuse an organization role other than admin", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organization_memberships (id, organization_id, person_id, role, status, created_at, updated_at) VALUES ('organization_membership_owner', ?, ?, 'owner', 'active', ?, ?)",
        )
        .run([SNACKDAY_ORGANIZATION_ID, OWNER, NOW, NOW]),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });
});
