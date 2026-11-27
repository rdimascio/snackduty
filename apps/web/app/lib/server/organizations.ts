/**
 * Organizations: the tenants of the one hosted product. A league, a club and a
 * solo coach are each one organization; a team belongs to exactly one through
 * `teams.organization_id`. Hostnames, modules and admin memberships hang off
 * the organization. `app/tenant/tenant.ts` reads the hostnames and modules to
 * resolve a request's tenant; nothing authorizes on these tables yet.
 */

import { defineTable, integer, text } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

export const SNACKDAY_ORGANIZATION_ID = "org_snackday";
export const COACH_ORGANIZATION_ID = "org_coach";
export const BALLPLAYER_ORGANIZATION_ID = "org_ballplayer";

export const ACTIVE = "active";

export const PRIMARY_HOSTNAME = 1;

const ORGANIZATION_KINDS = ["league", "club", "coach"] as const;
const ORGANIZATION_STATUSES = [ACTIVE, "archived"] as const;
export const ORGANIZATION_MODULES = ["teams", "cards", "lessons", "booking", "articles"] as const;
const HOSTNAME_KINDS = ["subdomain", "custom"] as const;
const HOSTNAME_STATUSES = ["pending", ACTIVE] as const;
const ORGANIZATION_ROLES = ["admin"] as const;
const ORGANIZATION_MEMBERSHIP_STATUSES = [ACTIVE, "ended"] as const;

type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];
export type OrganizationModule = (typeof ORGANIZATION_MODULES)[number];

export const organizations = defineTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default(ACTIVE),
  theme: text("theme").notNull(),
  logoKey: text("logo_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const organizationHostnames = defineTable("organization_hostnames", {
  hostname: text("hostname").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  cfCustomHostnameId: text("cf_custom_hostname_id"),
  isPrimary: integer("is_primary").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const organizationModules = defineTable("organization_modules", {
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  module: text("module").notNull(),
});

const ONE_PRIMARY_HOSTNAME_INDEX = "organization_hostnames_one_primary_idx";
const ONE_ACTIVE_MEMBERSHIP_INDEX = "organization_memberships_one_active_idx";
export const TEAMS_ORGANIZATION_INDEX = "teams_organization_id_idx";

interface SeededHostname {
  readonly hostname: string;
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

const SEEDED_HOSTNAME_KIND = "custom";

function host(hostname: string, isPrimary = false): SeededHostname {
  return { hostname, isPrimary };
}

/**
 * Today's three brands as organizations. `brand.ts` maps the Ballplayer and
 * coach hosts by name and treats every other host as Snackday, so the
 * Snackday rows list only the hosts `brand.test.ts` names; a staging, CI or
 * test host still reaches Snackday only through that fallback.
 */
const SEEDED_ORGANIZATIONS: readonly SeededOrganization[] = [
  {
    id: SNACKDAY_ORGANIZATION_ID,
    slug: "snackday",
    name: "Snackday",
    kind: "club",
    theme: "snackday",
    modules: ["teams", "cards", "lessons"],
    hostnames: [
      host("snackday.app", true),
      host("www.snackday.app"),
      host("localhost"),
      host("127.0.0.1"),
      host("[::1]"),
    ],
  },
  {
    id: COACH_ORGANIZATION_ID,
    slug: "coach",
    name: "DiMascio Baseball",
    kind: "coach",
    theme: "coach",
    modules: ["booking", "articles"],
    hostnames: [
      host("dimasciobaseball.com", true),
      host("www.dimasciobaseball.com"),
      host("coach.localhost"),
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
      host("ballplayer.co", true),
      host("www.ballplayer.co"),
      host("ballplayer.localhost"),
    ],
  },
];

/** The fixed timestamp of every seeded row, so the migration gives the same rows on every database. */
const ORGANIZATION_SEED_TIME = "2026-11-25T00:00:00.000Z";

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => sqlText(value)).join(", ");
}

function sqlFlag(value: boolean): string {
  return value ? "1" : "0";
}

const HOSTNAME_WHITESPACE = [" ", "\t", "\n", "\r", "\f", "\v"] as const;

/**
 * A stored hostname is the bare, lower-case host a request names: no port, no
 * trailing dot, no whitespace. A colon is allowed only inside a bracketed IPv6
 * literal such as `[::1]`, so `[::1]:3000` and `example.com:443` are refused.
 */
const HOSTNAME_RULES = [
  "hostname = lower(hostname)",
  "length(hostname) > 0",
  "hostname NOT LIKE '%.'",
  "(hostname NOT LIKE '%:%' OR (hostname LIKE '[%]' AND hostname NOT LIKE '%]%]'))",
  ...HOSTNAME_WHITESPACE.map((character) => `hostname NOT LIKE ${sqlText(`%${character}%`)}`),
];

const CREATE_ORGANIZATIONS = `CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug = lower(slug)),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${sqlList(ORGANIZATION_KINDS)})),
  status TEXT NOT NULL DEFAULT ${sqlText(ACTIVE)} CHECK (status IN (${sqlList(ORGANIZATION_STATUSES)})),
  theme TEXT NOT NULL,
  logo_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_ORGANIZATION_HOSTNAMES = `CREATE TABLE organization_hostnames (
  hostname TEXT PRIMARY KEY CHECK (${HOSTNAME_RULES.join(" AND ")}),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN (${sqlList(HOSTNAME_KINDS)})),
  status TEXT NOT NULL CHECK (status IN (${sqlList(HOSTNAME_STATUSES)})),
  cf_custom_hostname_id TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (is_primary = 0 OR status = ${sqlText(ACTIVE)})
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
      (seeded) =>
        `INSERT INTO organization_hostnames (hostname, organization_id, kind, status, cf_custom_hostname_id, is_primary, created_at, updated_at) VALUES (${sqlList(
          [seeded.hostname, organization.id, SEEDED_HOSTNAME_KIND, ACTIVE],
        )}, NULL, ${sqlFlag(seeded.isPrimary)}, ${time}, ${time})`,
    ),
  ]);
}

/**
 * The default keeps an app-only rollback working: the previous release inserts
 * teams without this column, and those teams land in Snackday. It stays until
 * team creation chooses an organization itself.
 */
const TEAM_ORGANIZATION_COLUMN = `organization_id TEXT NOT NULL DEFAULT ${sqlText(SNACKDAY_ORGANIZATION_ID)}`;

/**
 * SQLite (and D1) refuses `ADD COLUMN` with a REFERENCES clause and a non-NULL
 * default while foreign keys are on, so there the column has no foreign key.
 */
function teamOrganizationColumn(dialect: string): string {
  return dialect === "postgres"
    ? `${TEAM_ORGANIZATION_COLUMN} REFERENCES organizations(id)`
    : TEAM_ORGANIZATION_COLUMN;
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
      await schema.execute(
        `ALTER TABLE teams ADD COLUMN ${teamOrganizationColumn(schema.dialect)}`,
      );
      await schema.execute(`CREATE INDEX ${TEAMS_ORGANIZATION_INDEX} ON teams (organization_id)`);
    },
    down: async (schema) => {
      await schema.execute(`DROP INDEX ${TEAMS_ORGANIZATION_INDEX}`);
      await schema.execute("ALTER TABLE teams DROP COLUMN organization_id");
      await schema.execute("DROP TABLE organization_memberships");
      await schema.execute("DROP TABLE organization_modules");
      await schema.execute("DROP TABLE organization_hostnames");
      await schema.execute("DROP TABLE organizations");
    },
  },
};
