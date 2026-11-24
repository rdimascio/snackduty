import { and, eq, rawChanges } from "@lesto/db";
import type { BatchQuery, BatchResults, Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
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
import { errorChain } from "./error-chain";
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

export const BATCH_GUARD_TABLE = "batch_guard";

/** A table that stays empty: `abortUnless` writes NULL into its NOT NULL column to fail a batch. */
export const createBatchGuard: MigrationEntry = {
  version: "021_create_batch_guard",
  migration: {
    up: async (schema) => {
      await schema.execute(`CREATE TABLE ${BATCH_GUARD_TABLE} (ok INTEGER NOT NULL)`);
    },
    down: async (schema) => {
      await schema.execute(`DROP TABLE ${BATCH_GUARD_TABLE}`);
    },
  },
};

const BATCH_GUARD_COLUMN = "ok";

/**
 * A batch statement that fails, and so rolls back the whole batch, unless
 * `guard` is true when it runs. D1 cannot run JS between the statements of a
 * batch, so a multi-statement write checks its evidence in SQL instead.
 * `IS NOT TRUE` treats a NULL guard as failed, where `NOT (NULL)` would let
 * the batch commit.
 */
export function abortUnless(guard: SqlGuard): BatchQuery<{ changes: number }> {
  return rawChanges(
    `INSERT INTO ${BATCH_GUARD_TABLE} (${BATCH_GUARD_COLUMN}) SELECT NULL WHERE (${guard.sql}) IS NOT TRUE`,
    guard.params,
  );
}

/** The evidence a guarded batch was authorized with changed before it ran; nothing was written. */
export class EvidenceChangedError extends Error {
  constructor(options: { readonly cause: unknown }) {
    super("The evidence behind this write changed before the write ran.", options);
    this.name = "EvidenceChangedError";
  }
}

const POSTGRES_NOT_NULL_VIOLATION = "23502";
const SQLITE_GUARD_ABORT = new RegExp(
  `NOT NULL constraint failed: ${BATCH_GUARD_TABLE}\\.${BATCH_GUARD_COLUMN}(?![\\w.])`,
  "u",
);
const POSTGRES_GUARD_RELATION = `relation "${BATCH_GUARD_TABLE}"`;

function isPostgresGuardAbort(link: Error): boolean {
  const fields = link as { readonly code?: unknown; readonly table?: unknown };
  return (
    fields.code === POSTGRES_NOT_NULL_VIOLATION &&
    (fields.table === BATCH_GUARD_TABLE || link.message.includes(POSTGRES_GUARD_RELATION))
  );
}

/** Whether `error`, or any cause under it, is `abortUnless` failing its batch. */
export function isBatchGuardAbort(error: unknown): boolean {
  return errorChain(error).some(
    (link) =>
      link instanceof Error &&
      (SQLITE_GUARD_ABORT.test(link.message) || isPostgresGuardAbort(link)),
  );
}

/**
 * Run `writes` in one batch that ends with `abortUnless(guard)`, and throw
 * `EvidenceChangedError` when the guard fails so the caller can authorize
 * again and retry. The guard runs last so it also sees what `writes` changed,
 * and so that on Postgres at READ COMMITTED the unchecked window is only the
 * time from the guard to COMMIT: a revoke that commits after the guard
 * statement and before COMMIT is not seen. On D1 the batch is one atomic unit,
 * so there is no window.
 */
export async function runGuardedBatch<const Q extends readonly BatchQuery<unknown>[]>(
  db: Db,
  guard: SqlGuard,
  writes: Q,
): Promise<BatchResults<Q>> {
  try {
    const results = await db.batch([...writes, abortUnless(guard)]);
    return results.slice(0, writes.length) as BatchResults<Q>;
  } catch (error) {
    if (isBatchGuardAbort(error)) throw new EvidenceChangedError({ cause: error });
    throw error;
  }
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
