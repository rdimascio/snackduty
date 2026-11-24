import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import {
  accountIdSchema,
  accountSchema,
  evaluatePolicy,
  guardianRelationshipSchema,
  membershipSchema,
  participantIdSchema,
  personIdSchema,
  seasonIdSchema,
  teamIdSchema,
} from "@snackday/domain";
import type { DomainPermission, PolicyContext } from "@snackday/domain";
import { accounts, people } from "./identity";
import { adultMemberships, seasons, teams } from "./teams";
import { guardianRelationships, memberships, participants } from "./roster";

export interface AuthorizationTarget {
  readonly teamId: string;
  readonly seasonId?: string;
  readonly participantId?: string;
}

export interface SqlGuard {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * One primary-key EXISTS per evidence row the policy judged, each pinned to
 * the stored values the policy read. A write that ANDs the proof into its
 * WHERE lands only while that evidence is unchanged. Rows the loader skipped
 * need no clause: `evaluatePolicy` ignores inactive rows and is monotone in
 * active ones (strongest role wins, roster and guardian checks are `some`), so
 * a row that appears or turns active later can only add access. Loading active
 * rows only also keeps the bound parameter count under D1's limit of 100.
 */
export type EvidenceProof = readonly SqlGuard[];

const ACTIVE = "active";

type StoredValue = string | null;

function rowUnchanged(table: string, columns: Readonly<Record<string, StoredValue>>): SqlGuard {
  const entries = Object.entries(columns);
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${entries
      .map(([column, value]) =>
        value === null ? `${table}.${column} IS NULL` : `${table}.${column} = ?`,
      )
      .join(" AND ")})`,
    params: entries.flatMap(([, value]) => (value === null ? [] : [value])),
  };
}

export class EmptyEvidenceProofError extends Error {
  constructor() {
    super("An evidence proof must hold at least one clause.");
  }
}

/** AND several proofs into one WHERE fragment, keeping each identical clause once. */
export function proofGuard(...proofs: readonly EvidenceProof[]): SqlGuard {
  const clauses = new Map<string, SqlGuard>();
  for (const clause of proofs.flat()) {
    clauses.set(`${clause.sql}\u0000${JSON.stringify(clause.params)}`, clause);
  }
  const unique = [...clauses.values()];
  if (unique.length === 0) throw new EmptyEvidenceProofError();
  return {
    sql: unique.map((clause) => clause.sql).join(" AND "),
    params: unique.flatMap((clause) => clause.params),
  };
}

/** Load evidence inside the caller's transaction; the domain alone decides access. */
export async function authorizationContext(db: Db, personId: string, target: AuthorizationTarget) {
  const account = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.personId, personId), eq(accounts.status, "active")))
    .get();
  const person = await db
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.status, "active")))
    .get();
  if (account === undefined || person === undefined) return undefined;
  const team = await db.select().from(teams).where(eq(teams.id, target.teamId)).get();
  if (team === undefined) return undefined;
  const season =
    target.seasonId === undefined
      ? undefined
      : await db.select().from(seasons).where(eq(seasons.id, target.seasonId)).get();
  const adultRows = await db
    .select()
    .from(adultMemberships)
    .where(
      and(
        eq(adultMemberships.teamId, team.id),
        eq(adultMemberships.personId, personId),
        eq(adultMemberships.status, ACTIVE),
      ),
    )
    .all();
  const child =
    target.participantId === undefined
      ? undefined
      : await db
          .select()
          .from(participants)
          .where(and(eq(participants.id, target.participantId), eq(participants.status, "active")))
          .get();
  const rosterRows =
    child === undefined || target.seasonId === undefined
      ? []
      : await db
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.teamId, team.id),
              eq(memberships.seasonId, target.seasonId),
              eq(memberships.memberKind, "participant"),
              eq(memberships.memberParticipantId, child.id),
              eq(memberships.status, ACTIVE),
            ),
          )
          .all();
  const edges =
    child === undefined
      ? []
      : await db
          .select()
          .from(guardianRelationships)
          .where(
            and(
              eq(guardianRelationships.participantId, child.id),
              eq(guardianRelationships.guardianPersonId, personId),
              eq(guardianRelationships.status, ACTIVE),
            ),
          )
          .all();
  const proof: EvidenceProof = [
    rowUnchanged("accounts", {
      id: account.id,
      person_id: account.personId,
      status: account.status,
    }),
    rowUnchanged("people", { id: person.id, status: person.status }),
    rowUnchanged("teams", {
      id: team.id,
      status: team.status,
      created_by_person_id: team.createdByPersonId,
    }),
    ...(season === undefined
      ? []
      : [
          rowUnchanged("seasons", { id: season.id, team_id: season.teamId, status: season.status }),
        ]),
    ...adultRows.map((row) =>
      rowUnchanged("adult_memberships", {
        id: row.id,
        team_id: row.teamId,
        person_id: row.personId,
        role: row.role,
        status: row.status,
      }),
    ),
    ...(child === undefined
      ? []
      : [rowUnchanged("participants", { id: child.id, status: child.status })]),
    ...rosterRows.map((row) =>
      rowUnchanged("memberships", {
        id: row.id,
        team_id: row.teamId,
        season_id: row.seasonId,
        member_kind: row.memberKind,
        member_participant_id: row.memberParticipantId,
        status: row.status,
      }),
    ),
    ...edges.map((edge) =>
      rowUnchanged("guardian_relationships", {
        id: edge.id,
        guardian_person_id: edge.guardianPersonId,
        participant_id: edge.participantId,
        status: edge.status,
        permissions: edge.permissions,
      }),
    ),
  ];
  const context: PolicyContext = {
    account: accountSchema.parse(account),
    target: {
      teamId: teamIdSchema.parse(target.teamId),
      ...(target.seasonId === undefined ? {} : { seasonId: seasonIdSchema.parse(target.seasonId) }),
      ...(target.participantId === undefined
        ? {}
        : { participantId: participantIdSchema.parse(target.participantId) }),
    },
    team,
    ...(season === undefined ? {} : { season }),
    teamMemberships: adultRows,
    memberships: rosterRows.map((row) =>
      membershipSchema.parse({
        id: row.id,
        teamId: row.teamId,
        seasonId: row.seasonId,
        member: { kind: "participant", participantId: row.memberParticipantId },
        roleIds: [],
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
    roles: [],
    guardianRelationships: edges.map(({ guardianNameKey: _nameKey, ...edge }) =>
      guardianRelationshipSchema.parse({
        ...edge,
        permissions: JSON.parse(edge.permissions) as unknown,
      }),
    ),
  };
  return {
    team,
    context,
    proof,
    actor: {
      accountId: accountIdSchema.parse(account.id),
      personId: personIdSchema.parse(personId),
    },
  };
}

/** The proof of the evidence behind an allowed decision, or undefined when denied. */
export async function authorizedTeamOperationProof(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: AuthorizationTarget,
): Promise<EvidenceProof | undefined> {
  const evidence = await authorizationContext(db, personId, target);
  return evidence !== undefined &&
    evaluatePolicy(evidence.actor, permission, evidence.context).allowed
    ? evidence.proof
    : undefined;
}

export async function authorizeTeamOperation(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: AuthorizationTarget,
): Promise<boolean> {
  return (await authorizedTeamOperationProof(db, personId, permission, target)) !== undefined;
}
