import type { Sessions } from "@lesto/auth";
import { and, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { seasonSchema, teamSchema } from "@snackday/domain";
import { z } from "zod";

import { authenticatedAdult, people } from "./identity";

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
    const team = await tx
      .select()
      .from(teams)
      .where(
        and(
          eq(teams.id, c.param("teamId")),
          eq(teams.createdByPersonId, identity.person.id),
          eq(teams.status, "active"),
        ),
      )
      .get();
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

  const team = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.id, c.param("teamId")),
        eq(teams.createdByPersonId, identity.person.id),
        eq(teams.status, "active"),
      ),
    )
    .get();
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

export function registerTeamRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .post("/api/teams", (c) => createTeam(c, db, sessions))
    .post("/api/teams/:teamId/seasons", (c) => createSeason(c, db, sessions))
    .get("/api/teams/:teamId", (c) => readTeam(c, db, sessions));
}
