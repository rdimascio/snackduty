import type { Sessions } from "@lesto/auth";
import { and, createTableSql, defineTable, dropTableSql, eq, inList, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { seasonSchema, teamSchema } from "@snackday/domain";
import { z } from "zod";

import { accounts, authenticatedAdult, people } from "./identity";

export const teams = defineTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdByPersonId: text("created_by_person_id")
    .notNull()
    .references(() => people.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const seasons = defineTable("seasons", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  label: text("label").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  timeZone: text("time_zone").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createTeamsAndSeasons: MigrationEntry = {
  version: "004_create_teams_and_seasons",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(teams));
      schema.execute(createTableSql(seasons));
      schema.execute("CREATE INDEX teams_created_by_person_id_idx ON teams (created_by_person_id)");
      schema.execute("CREATE INDEX seasons_team_id_idx ON seasons (team_id)");
    },
    down: (schema) => {
      schema.execute(dropTableSql(seasons));
      schema.execute(dropTableSql(teams));
    },
  },
};

// Adult team membership is TEAM-scoped, mirroring how team ownership itself is
// scoped (`teams.created_by_person_id`): the season-scoped roster table
// (`memberships` in roster.ts) binds participants to one season, while a row
// here binds an invited adult to the whole team. Rows are written when an
// invitation is accepted (invitations.ts, which also owns the migration) and
// read by the `teamAccess` seam below.
export const adultMemberships = defineTable("adult_memberships", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  personId: text("person_id")
    .notNull()
    .references(() => people.id),
  role: text("role").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type TeamAccessLevel = "manage" | "read";

export type TeamRole = "owner" | "coach" | "adult";

/**
 * THE role → access rule, in exactly ONE place: owners and coaches manage team
 * operations, an adult may read, and an unknown role grants nothing. Ownership
 * is checked separately by `ownedActiveTeam`, so operational management never
 * implies permission to delegate another person's access.
 */
export function accessLevelForRole(role: string): TeamAccessLevel | undefined {
  if (role === "owner" || role === "coach") return "manage";
  return role === "adult" ? "read" : undefined;
}

const ROLE_RANK: Record<TeamRole, number> = { adult: 1, coach: 2, owner: 3 };

function isTeamRole(role: string): role is TeamRole {
  return role === "owner" || role === "coach" || role === "adult";
}

/**
 * Whether `role` grants strictly MORE than `held` (`undefined` = holds
 * nothing). The independent role rank preserves owner > coach > adult even
 * though owners and coaches both manage operational records.
 */
export function roleOutranks(role: string, held: string | undefined): boolean {
  if (!isTeamRole(role)) return false;
  if (held === undefined || !isTeamRole(held)) return true;
  return ROLE_RANK[role] > ROLE_RANK[held];
}

/**
 * Fold ACTIVE membership roles into the single grant they add up to: the
 * strongest role (owner outranks coach, which outranks adult) and its level, or undefined
 * when none of them grants anything. Every reader folds duplicate rows the same
 * way, so the authorization seam, the team list, and the role acceptance
 * reports can never disagree about one person's standing on one team.
 */
export function grantedAccess(
  roles: readonly string[],
): { role: TeamRole; level: TeamAccessLevel } | undefined {
  let held: TeamRole | undefined;
  for (const role of roles) {
    if (isTeamRole(role) && roleOutranks(role, held)) held = role;
  }
  if (held === undefined) return undefined;

  const level = accessLevelForRole(held);
  return level === undefined ? undefined : { role: held, level };
}

/**
 * THE team authorization seam: every team-scoped surface resolves the caller's
 * relationship to a team through this one helper (directly or via the
 * `manageableActiveTeam` / `readableActiveTeam` wrappers).
 *
 * - The CREATOR (`teams.created_by_person_id`) manages implicitly — creators
 *   may predate `adult_memberships` and never need a row.
 * - ACTIVE memberships are folded through `grantedAccess`: owners and coaches
 *   manage operations, adults read, and the strongest role wins.
 * - Everyone else — strangers, revoked or otherwise inactive memberships,
 *   unknown roles — resolves to undefined, and callers answer the same 404 a
 *   missing team gets: existence itself is never disclosed, never a 403.
 */
export async function teamAccess(tx: Db, teamId: string, personId: string) {
  const team = await tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.status, "active")))
    .get();
  if (team === undefined) return undefined;
  if (team.createdByPersonId === personId) return { team, level: "manage" as const };

  const membershipRows = await tx
    .select()
    .from(adultMemberships)
    .where(
      and(
        eq(adultMemberships.teamId, team.id),
        eq(adultMemberships.personId, personId),
        eq(adultMemberships.status, "active"),
      ),
    )
    .all();
  const granted = grantedAccess(membershipRows.map((membership) => membership.role));

  return granted === undefined ? undefined : { team, level: granted.level };
}

/**
 * The active team when `personId` may manage team operations (creator, owner,
 * or coach), or undefined. Roster, schedule, and duty mutations authorize
 * here; delegation and invitations use the narrower `ownedActiveTeam` seam.
 */
export async function manageableActiveTeam(tx: Db, teamId: string, personId: string) {
  const access = await teamAccess(tx, teamId, personId);
  return access?.level === "manage" ? access.team : undefined;
}

/**
 * The active team when `personId` owns it, either as its creator or through an
 * active owner membership. Delegation and invitations authorize here so a
 * coach can manage team operations without escalating anybody's access.
 */
export async function ownedActiveTeam(tx: Db, teamId: string, personId: string) {
  const team = await tx
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.status, "active")))
    .get();
  if (team === undefined) return undefined;
  if (team.createdByPersonId === personId) return team;

  const membershipRows = await tx
    .select()
    .from(adultMemberships)
    .where(
      and(
        eq(adultMemberships.teamId, team.id),
        eq(adultMemberships.personId, personId),
        eq(adultMemberships.status, "active"),
      ),
    )
    .all();
  return grantedAccess(membershipRows.map((membership) => membership.role))?.role === "owner"
    ? team
    : undefined;
}

/** The active team when `personId` may at least READ it, or undefined. */
export async function readableActiveTeam(tx: Db, teamId: string, personId: string) {
  return (await teamAccess(tx, teamId, personId))?.team;
}

export const createTeamInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Team name is required."),
});

export const createSeasonInputSchema = z
  .strictObject({
    label: z.string().trim().min(1, "Season label is required."),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timeZone: z.string().trim().min(1, "Time zone is required."),
  })
  .refine((season) => season.endDate >= season.startDate, {
    message: "End date must not precede start date",
    path: ["endDate"],
  });

const unauthorized = { error: "authentication required" } as const;
const notFound = { error: "team not found" } as const;
const adultMemberNotFound = { error: "adult team member not found" } as const;
const ownerRoleCannotChange = { error: "team owner role cannot change" } as const;

export function projectTeam(row: {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}) {
  return teamSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

async function createTeam(c: Context<"/api/teams">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(createTeamInputSchema);
  const now = new Date().toISOString();
  const row = await db
    .insert(teams)
    .values({
      id: `team_${crypto.randomUUID()}`,
      name: input.name,
      status: "active",
      createdByPersonId: identity.person.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  return c.json({ team: projectTeam(row) }, 201);
}

async function createSeason(c: Context<"/api/teams/:teamId/seasons">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(createSeasonInputSchema);
  const season = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const now = new Date().toISOString();
    const row = await tx
      .insert(seasons)
      .values({
        id: `season_${crypto.randomUUID()}`,
        teamId: team.id,
        label: input.label,
        startDate: input.startDate,
        endDate: input.endDate,
        timeZone: input.timeZone,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return seasonSchema.parse(row);
  });

  return season === null ? c.json(notFound, 404) : c.json({ season }, 201);
}

async function readTeam(c: Context<"/api/teams/:teamId">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const team = await readableActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(notFound, 404);

  const seasonRows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.teamId, team.id))
    .orderBy(seasons.startDate, "asc")
    .all();
  seasonRows.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
  );

  return c.json({
    team: projectTeam(team),
    seasons: seasonRows.map((season) => seasonSchema.parse(season)),
  });
}

async function setCoCoachRole(
  c: Context<
    | "/api/teams/:teamId/adult-members/:personId/co-coach/grant"
    | "/api/teams/:teamId/adult-members/:personId/co-coach/revoke"
  >,
  db: Db,
  sessions: Sessions,
  role: "coach" | "adult",
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await ownedActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return "no-team" as const;
    if (team.createdByPersonId === c.param("personId")) return "owner" as const;

    if (role === "coach") {
      const targetPerson = await tx
        .select()
        .from(people)
        .where(and(eq(people.id, c.param("personId")), eq(people.status, "active")))
        .get();
      const targetAccount = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.personId, c.param("personId")), eq(accounts.status, "active")))
        .get();
      if (targetPerson === undefined || targetAccount === undefined) return "no-member" as const;
    }

    const rows = await tx
      .select()
      .from(adultMemberships)
      .where(
        and(
          eq(adultMemberships.teamId, team.id),
          eq(adultMemberships.personId, c.param("personId")),
          eq(adultMemberships.status, "active"),
        ),
      )
      .all();
    const held = grantedAccess(rows.map((membership) => membership.role));
    if (held === undefined) return "no-member" as const;
    if (held.role === "owner") return "owner" as const;

    const now = new Date().toISOString();
    await tx
      .update(adultMemberships)
      .set({ role, updatedAt: now })
      .where(
        and(
          eq(adultMemberships.teamId, team.id),
          eq(adultMemberships.personId, c.param("personId")),
          eq(adultMemberships.status, "active"),
          inList(adultMemberships.role, ["adult", "coach"]),
        ),
      )
      .run();

    return { personId: c.param("personId"), role };
  });

  if (outcome === "no-team") return c.json(notFound, 404);
  if (outcome === "no-member") return c.json(adultMemberNotFound, 404);
  if (outcome === "owner") return c.json(ownerRoleCannotChange, 409);
  return c.json({ membership: { ...outcome, status: "active" as const } });
}

export function registerTeamRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .post("/api/teams", (c) => createTeam(c, db, sessions))
    .post("/api/teams/:teamId/seasons", (c) => createSeason(c, db, sessions))
    .post("/api/teams/:teamId/adult-members/:personId/co-coach/grant", (c) =>
      setCoCoachRole(c, db, sessions, "coach"),
    )
    .post("/api/teams/:teamId/adult-members/:personId/co-coach/revoke", (c) =>
      setCoCoachRole(c, db, sessions, "adult"),
    )
    .get("/api/teams/:teamId", (c) => readTeam(c, db, sessions));
}
