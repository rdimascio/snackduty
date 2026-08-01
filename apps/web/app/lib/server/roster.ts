import type { Sessions } from "@lesto/auth";
import { and, createTableSql, defineTable, dropTableSql, eq, inList, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema, participantSchema, personSchema } from "@snackday/domain";
import { z } from "zod";

import { authenticatedAdult, people } from "./identity";
import { manageableActiveTeam, seasons, teams } from "./teams";

export const participants = defineTable("participants", {
  id: text("id").primaryKey(),
  personId: text("person_id")
    .notNull()
    .references(() => people.id),
  birthDate: text("birth_date"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const guardianRelationships = defineTable("guardian_relationships", {
  id: text("id").primaryKey(),
  guardianPersonId: text("guardian_person_id")
    .notNull()
    .references(() => people.id),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id),
  relationship: text("relationship").notNull(),
  status: text("status").notNull(),
  permissions: text("permissions").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memberships = defineTable("memberships", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id),
  memberKind: text("member_kind").notNull(),
  memberPersonId: text("member_person_id").references(() => people.id),
  memberParticipantId: text("member_participant_id").references(() => participants.id),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createRoster: MigrationEntry = {
  version: "005_create_roster",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(participants));
      schema.execute(createTableSql(guardianRelationships));
      schema.execute(createTableSql(memberships));
      schema.execute(
        "CREATE INDEX guardian_relationships_participant_id_idx ON guardian_relationships (participant_id)",
      );
      schema.execute(
        "CREATE INDEX memberships_team_id_season_id_idx ON memberships (team_id, season_id)",
      );
    },
    down: (schema) => {
      schema.execute(dropTableSql(memberships));
      schema.execute(dropTableSql(guardianRelationships));
      schema.execute(dropTableSql(participants));
    },
  },
};

export const addParticipantInputSchema = z.strictObject({
  displayName: z.string().trim().min(1, "Participant display name is required."),
  birthDate: z.iso.date().optional(),
});

export const attachGuardianInputSchema = z.strictObject({
  displayName: z.string().trim().min(1, "Guardian display name is required."),
  relationship: guardianRelationshipSchema.shape.relationship,
  permissions: guardianRelationshipSchema.shape.permissions.default([
    "participant.read",
    "participant.manage",
  ]),
});

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const participantNotFound = { error: "participant not found" } as const;
const guardianAlreadyAttached = { error: "guardian already attached" } as const;

interface PersonRow {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function projectParticipant(
  row: {
    id: string;
    personId: string;
    birthDate: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  },
  person: PersonRow,
) {
  const participant = participantSchema.parse({
    id: row.id,
    personId: row.personId,
    ...(row.birthDate === null ? {} : { birthDate: row.birthDate }),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  return {
    participantId: participant.id,
    displayName: personSchema.parse(person).displayName,
    ...(participant.birthDate === undefined ? {} : { birthDate: participant.birthDate }),
    status: participant.status,
  };
}

export function projectGuardian(
  row: {
    id: string;
    guardianPersonId: string;
    participantId: string;
    relationship: string;
    status: string;
    permissions: string;
    createdAt: string;
    updatedAt: string;
  },
  person: PersonRow,
) {
  const edge = guardianRelationshipSchema.parse({
    id: row.id,
    guardianPersonId: row.guardianPersonId,
    participantId: row.participantId,
    relationship: row.relationship,
    status: row.status,
    permissions: JSON.parse(row.permissions) as unknown,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  return {
    guardianId: edge.id,
    displayName: personSchema.parse(person).displayName,
    relationship: edge.relationship,
    permissions: edge.permissions,
    status: edge.status,
  };
}

function insertActivePerson(tx: Db, displayName: string, now: string) {
  return tx
    .insert(people)
    .values({
      id: `person_${crypto.randomUUID()}`,
      displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

async function addParticipant(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/participants">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(addParticipantInputSchema);
  const participant = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const season = await tx
      .select()
      .from(seasons)
      .where(and(eq(seasons.id, c.param("seasonId")), eq(seasons.teamId, team.id)))
      .get();
    if (season === undefined) return null;

    // The child is a Person with no email and no Account — the identity split is
    // structural: this handler only ever writes `people`, never `accounts`.
    const now = new Date().toISOString();
    const person = await insertActivePerson(tx, input.displayName, now);
    const row = await tx
      .insert(participants)
      .values({
        id: `participant_${crypto.randomUUID()}`,
        personId: person.id,
        birthDate: input.birthDate ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await tx
      .insert(memberships)
      .values({
        id: `membership_${crypto.randomUUID()}`,
        teamId: team.id,
        seasonId: season.id,
        memberKind: "participant",
        memberParticipantId: row.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return projectParticipant(row, person);
  });

  return participant === null ? c.json(teamNotFound, 404) : c.json({ participant }, 201);
}

// Every attach call mints a fresh guardian Person (people carry no ownership column,
// so an arbitrary `guardianPersonId` reference could not be authorized owner-scoped).
// The duplicate_active_guardian invariant is honored pragmatically: a second identical
// displayName+relationship pair for the same participant is a conflict.
async function hasDuplicateActiveGuardian(
  tx: Db,
  participantId: string,
  input: { displayName: string; relationship: string },
): Promise<boolean> {
  const activeEdges = await tx
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.participantId, participantId),
        eq(guardianRelationships.relationship, input.relationship),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .all();
  if (activeEdges.length === 0) return false;

  const guardians = await tx
    .select()
    .from(people)
    .where(
      inList(
        people.id,
        activeEdges.map((edge) => edge.guardianPersonId),
      ),
    )
    .all();

  return guardians.some((guardian) => guardian.displayName === input.displayName);
}

async function attachGuardian(
  c: Context<"/api/participants/:participantId/guardians">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(attachGuardianInputSchema);
  const outcome = await db.transaction(async (tx) => {
    const participant = await tx
      .select()
      .from(participants)
      .where(and(eq(participants.id, c.param("participantId")), eq(participants.status, "active")))
      .get();
    if (participant === undefined) return null;

    const membership = await tx
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.memberParticipantId, participant.id),
          eq(memberships.memberKind, "participant"),
          eq(memberships.status, "active"),
        ),
      )
      .get();
    if (membership === undefined) return null;

    const team = await manageableActiveTeam(tx, membership.teamId, identity.person.id);
    if (team === undefined) return null;

    if (await hasDuplicateActiveGuardian(tx, participant.id, input)) return "duplicate" as const;

    const now = new Date().toISOString();
    const person = await insertActivePerson(tx, input.displayName, now);
    const edge = await tx
      .insert(guardianRelationships)
      .values({
        id: `guardian_relationship_${crypto.randomUUID()}`,
        guardianPersonId: person.id,
        participantId: participant.id,
        relationship: input.relationship,
        status: "active",
        permissions: JSON.stringify(input.permissions),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return projectGuardian(edge, person);
  });

  if (outcome === null) return c.json(participantNotFound, 404);
  if (outcome === "duplicate") return c.json(guardianAlreadyAttached, 409);

  return c.json({ guardian: outcome }, 201);
}

export function registerRosterRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .post("/api/teams/:teamId/seasons/:seasonId/participants", (c) =>
      addParticipant(c, db, sessions),
    )
    .post("/api/participants/:participantId/guardians", (c) => attachGuardian(c, db, sessions));
}
