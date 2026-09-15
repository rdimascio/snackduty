import type { SessionService as Sessions } from "./application-contracts";
import { and, createTableSql, defineTable, dropTableSql, eq, inList, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema, participantSchema, personSchema } from "@snackday/domain";
import { z } from "zod";

import { authenticatedAdult, people } from "./identity";
import { childIdentityKey, sameDisplayName } from "./people-identity";
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

/**
 * What a guardian gets when nobody says otherwise — one constant, shared by the
 * manual attach path, roster import, and invitation acceptance, so the three
 * cannot drift into granting different things for the same relationship.
 */
export const DEFAULT_GUARDIAN_PERMISSIONS = ["participant.read", "participant.manage"] as const;

export const addParticipantInputSchema = z.strictObject({
  displayName: z.string().trim().min(1, "Participant display name is required."),
  birthDate: z.iso.date().optional(),
});

export const attachGuardianInputSchema = z.strictObject({
  displayName: z.string().trim().min(1, "Guardian display name is required."),
  relationship: guardianRelationshipSchema.shape.relationship,
  permissions: guardianRelationshipSchema.shape.permissions.default([
    ...DEFAULT_GUARDIAN_PERMISSIONS,
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

/**
 * Create one child on one season's roster: the Person, the Participant, and the
 * season membership that puts them on the roster. THE one place a child record
 * is written — the single-add endpoint and the CSV import both go through here,
 * so "a child is a Person with no Account and no email" is enforced once.
 */
export async function createRosteredParticipant(
  tx: Db,
  target: { teamId: string; seasonId: string },
  input: { displayName: string; birthDate?: string | undefined },
  now: string,
) {
  // The child is a Person with no email and no Account — the identity split is
  // structural: this function only ever writes `people`, never `accounts`.
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
      teamId: target.teamId,
      seasonId: target.seasonId,
      memberKind: "participant",
      memberParticipantId: row.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { row, person };
}

/**
 * Attach one guardian to one child, minting the placeholder Person that carries
 * their name. THE one place a guardian edge is written from a typed-in name
 * (the manual endpoint and the CSV import); invitation acceptance writes its
 * own edge because it binds an EXISTING adult identity instead of a placeholder.
 */
export async function attachGuardianEdge(
  tx: Db,
  participantId: string,
  input: { displayName: string; relationship: string; permissions: readonly string[] },
  now: string,
) {
  const person = await insertActivePerson(tx, input.displayName, now);
  const edge = await tx
    .insert(guardianRelationships)
    .values({
      id: `guardian_relationship_${crypto.randomUUID()}`,
      guardianPersonId: person.id,
      participantId,
      relationship: input.relationship,
      status: "active",
      permissions: JSON.stringify(input.permissions),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  return { edge, person };
}

/**
 * Every child already on one season's roster, keyed by the shared child-identity
 * rule (people-identity.ts). The roster import's duplicate-in-roster verdict is
 * a lookup in this set — and because the commit rebuilds it inside its own
 * transaction, replaying a commit finds every child it created last time.
 */
export async function seasonChildIdentityKeys(
  tx: Db,
  teamId: string,
  seasonId: string,
): Promise<Set<string>> {
  const participantRows = await activeSeasonParticipantRows(tx, teamId, seasonId);
  if (participantRows.length === 0) return new Set();

  const personRows = await tx
    .select()
    .from(people)
    .where(
      inList(
        people.id,
        participantRows.map((participant) => participant.personId),
      ),
    )
    .all();
  const peopleById = new Map(personRows.map((person) => [person.id, person] as const));

  const keys = new Set<string>();
  for (const participant of participantRows) {
    const person = peopleById.get(participant.personId);
    if (person === undefined) continue;
    keys.add(
      childIdentityKey({ displayName: person.displayName, birthDate: participant.birthDate }),
    );
  }

  return keys;
}

/**
 * The ACTIVE participants rostered on one team's season. The roster read
 * projection (team-reads.ts) and the import's duplicate check both start here,
 * so "who is on this roster" has one answer.
 */
export async function activeSeasonParticipantRows(tx: Db, teamId: string, seasonId: string) {
  const membershipRows = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.seasonId, seasonId),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .all();
  const memberParticipantIds = membershipRows
    .map((membership) => membership.memberParticipantId)
    .filter((participantId): participantId is string => participantId !== null);
  if (memberParticipantIds.length === 0) return [];

  return tx
    .select()
    .from(participants)
    .where(and(inList(participants.id, memberParticipantIds), eq(participants.status, "active")))
    .all();
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

    const { row, person } = await createRosteredParticipant(
      tx,
      { teamId: team.id, seasonId: season.id },
      input,
      new Date().toISOString(),
    );

    return projectParticipant(row, person);
  });

  return participant === null ? c.json(teamNotFound, 404) : c.json({ participant }, 201);
}

/**
 * The ACTIVE guardian edge on `participantId` whose guardian is, by the shared
 * person-identity rule, the same person as `input` — or undefined.
 *
 * Every attach call mints a fresh guardian Person (people carry no ownership
 * column, so an arbitrary `guardianPersonId` reference could not be authorized
 * owner-scoped), which is exactly why identity here is a NAME question and not
 * an id question. The duplicate_active_guardian invariant is this lookup coming
 * back defined; invitation acceptance uses the same lookup to recognize the
 * placeholder a manager typed in and rebind it instead of duplicating it.
 */
export async function findActiveGuardianByIdentity(
  tx: Db,
  participantId: string,
  input: { displayName: string; relationship: string },
) {
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
  if (activeEdges.length === 0) return undefined;

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
  const matched = new Set(
    guardians
      .filter((guardian) => sameDisplayName(guardian.displayName, input.displayName))
      .map((guardian) => guardian.id),
  );

  return activeEdges.find((edge) => matched.has(edge.guardianPersonId));
}

export async function hasDuplicateActiveGuardian(
  tx: Db,
  participantId: string,
  input: { displayName: string; relationship: string },
): Promise<boolean> {
  return (await findActiveGuardianByIdentity(tx, participantId, input)) !== undefined;
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

    const { edge, person } = await attachGuardianEdge(
      tx,
      participant.id,
      input,
      new Date().toISOString(),
    );

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
