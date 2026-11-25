import { readFile } from "node:fs/promises";

import { installSessionSchema } from "@lesto/auth";
import type { SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { seedFiles } from "../app/dev/seed-database";
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
    expect(await rows(sql, "SELECT name FROM sqlite_master WHERE name = 'teams_v022'")).toEqual([]);
    expect(await indexNames(sql, "teams")).toEqual([
      "teams_created_by_person_id_idx",
      TEAMS_ORGANIZATION_INDEX,
    ]);
    expect(await rows(sql, "PRAGMA foreign_key_list(teams)")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "organizations", from: "organization_id", to: "id" }),
        expect.objectContaining({ table: "people", from: "created_by_person_id", to: "id" }),
      ]),
    );
  });

  it("keeps the season foreign key on the rebuilt teams table", async () => {
    const sql = await teamsBeforeOrganizations();
    await migrateAll(sql);

    await expect(
      sql
        .prepare(
          "INSERT INTO seasons (id, team_id, label, start_date, end_date, time_zone, status, created_at, updated_at) VALUES ('season_orphan', 'team_missing', 'Fall', '2026-09-01', '2026-12-01', 'UTC', 'active', ?, ?)",
        )
        .run([NOW, NOW]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
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
        ["ballplayer.co", BALLPLAYER_ORGANIZATION_ID, 1],
        ["ballplayer.localhost", BALLPLAYER_ORGANIZATION_ID, 0],
        ["coach.localhost", COACH_ORGANIZATION_ID, 0],
        ["dimasciobaseball.com", COACH_ORGANIZATION_ID, 1],
        ["localhost", SNACKDAY_ORGANIZATION_ID, 0],
        ["snackday.app", SNACKDAY_ORGANIZATION_ID, 1],
        ["www.ballplayer.co", BALLPLAYER_ORGANIZATION_ID, 0],
        ["www.dimasciobaseball.com", COACH_ORGANIZATION_ID, 0],
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

  it("refuse a team in an organization that does not exist", async () => {
    const sql = await migrated();
    await expect(insertTeam(sql, "team_unknown_org", "org_missing")).rejects.toThrow(
      /FOREIGN KEY constraint failed/u,
    );
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

  it("refuse a host name that is not lower case", async () => {
    const sql = await migrated();
    await expect(
      sql
        .prepare(
          "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, created_at, updated_at) VALUES ('Teams.Snackday.App', ?, 'subdomain', 'active', ?, ?)",
        )
        .run([SNACKDAY_ORGANIZATION_ID, NOW, NOW]),
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
