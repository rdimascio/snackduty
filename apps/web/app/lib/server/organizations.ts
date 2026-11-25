/**
 * Organizations: the tenants of the one hosted product. A league, a club and a
 * solo coach are each one organization; a team belongs to exactly one through
 * `teams.organization_id`. Hostnames, modules and admin memberships hang off
 * the organization. Nothing routes or authorizes on these tables yet.
 */

import { defineTable, text } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

export const SNACKDAY_ORGANIZATION_ID = "org_snackday";
export const COACH_ORGANIZATION_ID = "org_coach";
export const BALLPLAYER_ORGANIZATION_ID = "org_ballplayer";

export const ORGANIZATION_KINDS = ["league", "club", "coach"] as const;
export const ORGANIZATION_STATUSES = ["active", "archived"] as const;
export const ORGANIZATION_MODULES = ["teams", "cards", "lessons", "booking", "articles"] as const;
export const HOSTNAME_KINDS = ["subdomain", "custom"] as const;
export const HOSTNAME_STATUSES = ["pending", "active", "removed"] as const;
export const ORGANIZATION_ROLES = ["admin"] as const;
export const ORGANIZATION_MEMBERSHIP_STATUSES = ["active", "ended"] as const;

type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];
type OrganizationModule = (typeof ORGANIZATION_MODULES)[number];
type HostnameKind = (typeof HOSTNAME_KINDS)[number];

export const organizations = defineTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  theme: text("theme").notNull(),
  logoKey: text("logo_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const ONE_PRIMARY_HOSTNAME_INDEX = "organization_hostnames_one_primary_idx";
export const ONE_ACTIVE_MEMBERSHIP_INDEX = "organization_memberships_one_active_idx";
export const TEAMS_ORGANIZATION_INDEX = "teams_organization_id_idx";

interface SeededHostname {
  readonly hostname: string;
  readonly kind: HostnameKind;
  readonly isPrimary: boolean;
}

interface SeededOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: OrganizationKind;
  readonly theme: string;
  readonly modules: readonly OrganizationModule[];
  readonly hostnames: readonly SeededHostname[];
}

const productionHost = (hostname: string, isPrimary = false): SeededHostname => ({
  hostname,
  kind: "custom",
  isPrimary,
});
const developmentHost = (hostname: string): SeededHostname => ({
  hostname,
  kind: "custom",
  isPrimary: false,
});

/**
 * Today's three brands as organizations. The hosts are the ones `brand.ts`
 * maps today plus each brand's local development host, so the tenant resolver
 * can replace `brand.ts` without a lookup miss.
 */
export const SEEDED_ORGANIZATIONS: readonly SeededOrganization[] = [
  {
    id: SNACKDAY_ORGANIZATION_ID,
    slug: "snackday",
    name: "Snackday",
    kind: "club",
    theme: "snackday",
    modules: ["teams", "cards", "lessons"],
    hostnames: [productionHost("snackday.app", true), developmentHost("localhost")],
  },
  {
    id: COACH_ORGANIZATION_ID,
    slug: "coach",
    name: "DiMascio Baseball",
    kind: "coach",
    theme: "coach",
    modules: ["booking", "articles"],
    hostnames: [
      productionHost("dimasciobaseball.com", true),
      productionHost("www.dimasciobaseball.com"),
      developmentHost("coach.localhost"),
    ],
  },
  {
    id: BALLPLAYER_ORGANIZATION_ID,
    slug: "ballplayer",
    name: "Ballplayer",
    kind: "club",
    theme: "ballplayer",
    modules: ["cards"],
    hostnames: [
      productionHost("ballplayer.co", true),
      productionHost("www.ballplayer.co"),
      developmentHost("ballplayer.localhost"),
    ],
  },
];

/** The fixed timestamp of every seeded row, so the migration gives the same rows on every database. */
export const ORGANIZATION_SEED_TIME = "2026-11-25T00:00:00.000Z";

const ACTIVE = "active";

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => sqlText(value)).join(", ");
}

function sqlFlag(value: boolean): string {
  return value ? "1" : "0";
}

const CREATE_ORGANIZATIONS = `CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${sqlList(ORGANIZATION_KINDS)})),
  status TEXT NOT NULL DEFAULT ${sqlText(ACTIVE)} CHECK (status IN (${sqlList(ORGANIZATION_STATUSES)})),
  theme TEXT NOT NULL,
  logo_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_ORGANIZATION_HOSTNAMES = `CREATE TABLE organization_hostnames (
  hostname TEXT PRIMARY KEY CHECK (hostname = lower(hostname)),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN (${sqlList(HOSTNAME_KINDS)})),
  status TEXT NOT NULL CHECK (status IN (${sqlList(HOSTNAME_STATUSES)})),
  cf_custom_hostname_id TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_ORGANIZATION_MODULES = `CREATE TABLE organization_modules (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  module TEXT NOT NULL CHECK (module IN (${sqlList(ORGANIZATION_MODULES)})),
  PRIMARY KEY (organization_id, module)
)`;

const CREATE_ORGANIZATION_MEMBERSHIPS = `CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN (${sqlList(ORGANIZATION_ROLES)})),
  status TEXT NOT NULL CHECK (status IN (${sqlList(ORGANIZATION_MEMBERSHIP_STATUSES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const ORGANIZATION_INDEXES = [
  `CREATE UNIQUE INDEX ${ONE_PRIMARY_HOSTNAME_INDEX} ON organization_hostnames (organization_id) WHERE is_primary = 1`,
  "CREATE INDEX organization_hostnames_organization_id_idx ON organization_hostnames (organization_id)",
  `CREATE UNIQUE INDEX ${ONE_ACTIVE_MEMBERSHIP_INDEX} ON organization_memberships (organization_id, person_id) WHERE status = ${sqlText(ACTIVE)}`,
  "CREATE INDEX organization_memberships_person_id_idx ON organization_memberships (person_id)",
];

function seedStatements(): string[] {
  const time = sqlText(ORGANIZATION_SEED_TIME);
  return SEEDED_ORGANIZATIONS.flatMap((organization) => [
    `INSERT INTO organizations (id, slug, name, kind, status, theme, logo_key, created_at, updated_at) VALUES (${sqlList(
      [
        organization.id,
        organization.slug,
        organization.name,
        organization.kind,
        ACTIVE,
        organization.theme,
      ],
    )}, NULL, ${time}, ${time})`,
    ...organization.modules.map(
      (module) =>
        `INSERT INTO organization_modules (organization_id, module) VALUES (${sqlList([organization.id, module])})`,
    ),
    ...organization.hostnames.map(
      (host) =>
        `INSERT INTO organization_hostnames (hostname, organization_id, kind, status, cf_custom_hostname_id, is_primary, created_at, updated_at) VALUES (${sqlList(
          [host.hostname, organization.id, host.kind, ACTIVE],
        )}, NULL, ${sqlFlag(host.isPrimary)}, ${time}, ${time})`,
    ),
  ]);
}

type MigrationSchema = Parameters<MigrationEntry["migration"]["up"]>[0];

const TEAM_COLUMNS_V004 = "id, name, status, created_by_person_id, created_at, updated_at";
const TEAM_COLUMN_DEFINITIONS_V004 =
  '"id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL, "created_by_person_id" TEXT NOT NULL REFERENCES "people"("id"), "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL';
const TEAM_ORGANIZATION_COLUMN_DEFINITION =
  '"organization_id" TEXT NOT NULL REFERENCES "organizations"("id")';
const TEAMS_CREATED_BY_INDEX =
  "CREATE INDEX teams_created_by_person_id_idx ON teams (created_by_person_id)";
const TEAMS_ORGANIZATION_INDEX_SQL = `CREATE INDEX ${TEAMS_ORGANIZATION_INDEX} ON teams (organization_id)`;
const TEAMS_HOLDING_TABLE = "teams_v022";

/**
 * SQLite cannot add a NOT NULL foreign key column, and a migration runs inside
 * a transaction where `PRAGMA foreign_keys = OFF` has no effect. So `teams` is
 * copied out, dropped and created again under the same name with deferred
 * foreign keys: the child rows that lose their parent at the DROP count as
 * violations until the INSERT puts every parent back, and the commit fails if
 * one is still missing.
 */
async function rebuildSqliteTeams(
  schema: MigrationSchema,
  shape: { readonly definitions: string; readonly columns: string; readonly select: string },
): Promise<void> {
  await schema.execute("PRAGMA defer_foreign_keys = ON");
  await schema.execute(
    `CREATE TABLE ${TEAMS_HOLDING_TABLE} AS SELECT ${TEAM_COLUMNS_V004} FROM teams`,
  );
  await schema.execute("DROP TABLE teams");
  await schema.execute(`CREATE TABLE "teams" (${shape.definitions})`);
  await schema.execute(
    `INSERT INTO teams (${shape.columns}) SELECT ${shape.select} FROM ${TEAMS_HOLDING_TABLE}`,
  );
  await schema.execute(`DROP TABLE ${TEAMS_HOLDING_TABLE}`);
  await schema.execute(TEAMS_CREATED_BY_INDEX);
}

async function addTeamOrganization(schema: MigrationSchema): Promise<void> {
  if (schema.dialect === "postgres") {
    await schema.execute(
      "ALTER TABLE teams ADD COLUMN organization_id TEXT REFERENCES organizations(id)",
    );
    await schema.execute(`UPDATE teams SET organization_id = ${sqlText(SNACKDAY_ORGANIZATION_ID)}`);
    await schema.execute("ALTER TABLE teams ALTER COLUMN organization_id SET NOT NULL");
  } else {
    await rebuildSqliteTeams(schema, {
      definitions: `${TEAM_COLUMN_DEFINITIONS_V004}, ${TEAM_ORGANIZATION_COLUMN_DEFINITION}`,
      columns: `${TEAM_COLUMNS_V004}, organization_id`,
      select: `${TEAM_COLUMNS_V004}, ${sqlText(SNACKDAY_ORGANIZATION_ID)}`,
    });
  }
  await schema.execute(TEAMS_ORGANIZATION_INDEX_SQL);
}

async function dropTeamOrganization(schema: MigrationSchema): Promise<void> {
  await schema.execute(`DROP INDEX ${TEAMS_ORGANIZATION_INDEX}`);
  if (schema.dialect === "postgres") {
    await schema.execute("ALTER TABLE teams DROP COLUMN organization_id");
    return;
  }
  await rebuildSqliteTeams(schema, {
    definitions: TEAM_COLUMN_DEFINITIONS_V004,
    columns: TEAM_COLUMNS_V004,
    select: TEAM_COLUMNS_V004,
  });
}

export const createOrganizations: MigrationEntry = {
  version: "022_create_organizations",
  migration: {
    up: async (schema) => {
      await schema.execute(CREATE_ORGANIZATIONS);
      await schema.execute(CREATE_ORGANIZATION_HOSTNAMES);
      await schema.execute(CREATE_ORGANIZATION_MODULES);
      await schema.execute(CREATE_ORGANIZATION_MEMBERSHIPS);
      for (const statement of ORGANIZATION_INDEXES) await schema.execute(statement);
      for (const statement of seedStatements()) await schema.execute(statement);
      await addTeamOrganization(schema);
    },
    down: async (schema) => {
      await dropTeamOrganization(schema);
      await schema.execute("DROP TABLE organization_memberships");
      await schema.execute("DROP TABLE organization_modules");
      await schema.execute("DROP TABLE organization_hostnames");
      await schema.execute("DROP TABLE organizations");
    },
  },
};
