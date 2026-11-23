/**
 * The stored roster name keys and the partial UNIQUE indexes that enforce the
 * two roster duplicate invariants in the database (people-identity.ts has the
 * rule and why it is never identity proof).
 *
 *   - `guardian_relationships.guardian_name_key`: `storedGuardianNameKey` of a
 *     PLACEHOLDER guardian (a typed-in Person with no Account). Unique per
 *     participant + relationship among active links. NULL on an account-bound
 *     link, so the index cannot catch a placeholder link written without a key.
 *   - `memberships.child_identity_key`: `storedChildIdentityKey` of the
 *     rostered child. Unique per season among active participant memberships,
 *     and a CHECK refuses a participant membership without one.
 *
 * SQLite and Postgres cannot compute the Unicode normalization, so the key is
 * computed in JS on every write and by the JS backfill in this migration.
 */

import type { MigrationEntry } from "@lesto/migrate";
import { z } from "zod";

import { storedChildIdentityKey, storedGuardianNameKey } from "./people-identity";

export const GUARDIAN_NAME_KEY_COLUMN = "guardian_name_key";
export const CHILD_IDENTITY_KEY_COLUMN = "child_identity_key";
export const GUARDIAN_NAME_KEY_INDEX = "guardian_relationships_active_guardian_name_key_idx";
export const CHILD_IDENTITY_KEY_INDEX = "memberships_active_child_identity_key_idx";
export const PARTICIPANT_CHILD_KEY_CHECK = "memberships_participant_child_key_check";
const PARTICIPANT_CHILD_KEY_RULE = `member_kind <> 'participant' OR ${CHILD_IDENTITY_KEY_COLUMN} IS NOT NULL`;

export const ROSTER_NAME_KEY_CONFLICT = "ROSTER_NAME_KEY_CONFLICT";

/**
 * The stored guardian key. Only a placeholder guardian gets one: an
 * account-bound link (invitation acceptance) is never judged by name.
 */
export const ACCOUNT_BOUND_GUARDIAN_NAME_KEY = null;

export async function guardianNameKey(guardian: {
  readonly displayName: string;
  readonly hasAccount: boolean;
}): Promise<string | null> {
  return guardian.hasAccount
    ? ACCOUNT_BOUND_GUARDIAN_NAME_KEY
    : storedGuardianNameKey(guardian.displayName);
}

/**
 * Existing rows break an index the migration is about to create. It names the
 * conflicting row ids, never a name or birth date.
 */
export class RosterNameKeyConflictError extends Error {
  readonly code = ROSTER_NAME_KEY_CONFLICT;
  readonly guardianConflicts: number;
  readonly childConflicts: number;

  constructor(
    readonly guardianRelationshipIds: readonly (readonly string[])[],
    readonly membershipIds: readonly (readonly string[])[],
  ) {
    super(
      `${ROSTER_NAME_KEY_CONFLICT}: ${guardianRelationshipIds.length} duplicate active guardian group(s) ` +
        `(guardian_relationships.id ${JSON.stringify(guardianRelationshipIds)}) and ` +
        `${membershipIds.length} duplicate active child group(s) ` +
        `(memberships.id ${JSON.stringify(membershipIds)}) already exist. ` +
        "Archive or fix those rows by hand, then run the migration again. No row was changed.",
    );
    this.name = "RosterNameKeyConflictError";
    this.guardianConflicts = guardianRelationshipIds.length;
    this.childConflicts = membershipIds.length;
  }
}

/** The SQL surface the backfill needs; both migration and app handles satisfy it. */
export interface RosterNameKeySql {
  prepare(sql: string): {
    all(params?: unknown[]): Promise<unknown[]>;
    run(params?: unknown[]): Promise<unknown>;
  };
}

const guardianRowSchema = z.object({
  id: z.string(),
  participant_id: z.string(),
  relationship: z.string(),
  status: z.string(),
  display_name: z.string(),
  account_id: z.string().nullable(),
});

const childRowSchema = z.object({
  id: z.string(),
  season_id: z.string(),
  status: z.string(),
  display_name: z.string(),
  birth_date: z.string().nullable(),
});

const ACTIVE = "active";

/** The ids of every group of rows that share one scope, for groups of two or more. */
function conflictGroups(
  rows: readonly { readonly id: string; readonly scope: readonly string[] }[],
): string[][] {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const scopeKey = JSON.stringify(row.scope);
    groups.set(scopeKey, [...(groups.get(scopeKey) ?? []), row.id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1).map((ids) => ids.toSorted());
}

/**
 * Compute and write every stored roster name key from the current rows. Throws
 * `RosterNameKeyConflictError` BEFORE writing anything when active rows already
 * share a key, so a conflict never gets merged or dropped silently.
 */
export async function backfillRosterNameKeys(sql: RosterNameKeySql): Promise<void> {
  const guardianRows = z
    .array(guardianRowSchema)
    .parse(
      await sql
        .prepare(
          "SELECT edge.id, edge.participant_id, edge.relationship, edge.status, guardian.display_name, account.id AS account_id FROM guardian_relationships edge JOIN people guardian ON guardian.id = edge.guardian_person_id LEFT JOIN accounts account ON account.person_id = edge.guardian_person_id",
        )
        .all(),
    );
  const guardianKeys = await Promise.all(
    guardianRows.map((row) =>
      guardianNameKey({ displayName: row.display_name, hasAccount: row.account_id !== null }),
    ),
  );
  const guardians = guardianRows.map((row, index) => ({
    ...row,
    key: guardianKeys[index] ?? null,
  }));

  const childRows = z
    .array(childRowSchema)
    .parse(
      await sql
        .prepare(
          "SELECT membership.id, membership.season_id, membership.status, child.display_name, participant.birth_date FROM memberships membership JOIN participants participant ON participant.id = membership.member_participant_id JOIN people child ON child.id = participant.person_id WHERE membership.member_kind = 'participant'",
        )
        .all(),
    );
  const childKeys = await Promise.all(
    childRows.map((row) =>
      storedChildIdentityKey({ displayName: row.display_name, birthDate: row.birth_date }),
    ),
  );
  const children = childRows.map((row, index) => ({ ...row, key: childKeys[index] ?? "" }));

  const guardianConflicts = conflictGroups(
    guardians.flatMap((row) =>
      row.status === ACTIVE && row.key !== null
        ? [{ id: row.id, scope: [row.participant_id, row.relationship, row.key] }]
        : [],
    ),
  );
  const childConflicts = conflictGroups(
    children.flatMap((row) =>
      row.status === ACTIVE ? [{ id: row.id, scope: [row.season_id, row.key] }] : [],
    ),
  );
  if (guardianConflicts.length > 0 || childConflicts.length > 0) {
    throw new RosterNameKeyConflictError(guardianConflicts, childConflicts);
  }

  for (const row of guardians) {
    await sql
      .prepare(`UPDATE guardian_relationships SET ${GUARDIAN_NAME_KEY_COLUMN} = ? WHERE id = ?`)
      .run([row.key, row.id]);
  }
  for (const row of children) {
    await sql
      .prepare(`UPDATE memberships SET ${CHILD_IDENTITY_KEY_COLUMN} = ? WHERE id = ?`)
      .run([row.key, row.id]);
  }
}

/**
 * The migration's transaction handle. @lesto/migrate 0.2 hands a migration a
 * `Schema` that exposes only `execute()`, but it is built on the run's own
 * transaction handle, so the backfill reads and writes inside the same
 * transaction as the DDL.
 */
function migrationConnection(schema: object): RosterNameKeySql {
  const handle: unknown = Reflect.get(schema, "db");
  if (
    typeof handle !== "object" ||
    handle === null ||
    typeof (handle as { prepare?: unknown }).prepare !== "function"
  ) {
    throw new Error("The migration schema no longer exposes its transaction handle.");
  }
  return handle as RosterNameKeySql;
}

type MigrationSchema = Parameters<MigrationEntry["migration"]["up"]>[0];

const MEMBERSHIP_COLUMNS_V005 =
  "id, team_id, season_id, member_kind, member_person_id, member_participant_id, status, created_at, updated_at";
const MEMBERSHIP_COLUMN_DEFINITIONS_V005 =
  '"id" TEXT PRIMARY KEY, "team_id" TEXT NOT NULL REFERENCES "teams"("id"), "season_id" TEXT NOT NULL REFERENCES "seasons"("id"), "member_kind" TEXT NOT NULL, "member_person_id" TEXT REFERENCES "people"("id"), "member_participant_id" TEXT REFERENCES "participants"("id"), "status" TEXT NOT NULL, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL';
const MEMBERSHIP_TEAM_SEASON_INDEX =
  "CREATE INDEX memberships_team_id_season_id_idx ON memberships (team_id, season_id)";

/** SQLite cannot add a CHECK to an existing table, so it rebuilds `memberships`. */
async function rebuildSqliteMemberships(
  schema: MigrationSchema,
  shape: { readonly definitions: string; readonly columns: string },
): Promise<void> {
  await schema.execute(`CREATE TABLE memberships_v020 (${shape.definitions})`);
  await schema.execute(
    `INSERT INTO memberships_v020 (${shape.columns}) SELECT ${shape.columns} FROM memberships`,
  );
  await schema.execute("DROP TABLE memberships");
  await schema.execute("ALTER TABLE memberships_v020 RENAME TO memberships");
  await schema.execute(MEMBERSHIP_TEAM_SEASON_INDEX);
}

/** Runs after the backfill, so every existing participant membership has its key. */
async function requireParticipantChildKey(schema: MigrationSchema): Promise<void> {
  if (schema.dialect === "postgres") {
    await schema.execute(
      `ALTER TABLE memberships ADD CONSTRAINT ${PARTICIPANT_CHILD_KEY_CHECK} CHECK (${PARTICIPANT_CHILD_KEY_RULE})`,
    );
    return;
  }
  await rebuildSqliteMemberships(schema, {
    definitions: `${MEMBERSHIP_COLUMN_DEFINITIONS_V005}, "${CHILD_IDENTITY_KEY_COLUMN}" TEXT, CONSTRAINT ${PARTICIPANT_CHILD_KEY_CHECK} CHECK (${PARTICIPANT_CHILD_KEY_RULE})`,
    columns: `${MEMBERSHIP_COLUMNS_V005}, ${CHILD_IDENTITY_KEY_COLUMN}`,
  });
}

async function dropParticipantChildKey(schema: MigrationSchema): Promise<void> {
  if (schema.dialect === "postgres") {
    await schema.execute(`ALTER TABLE memberships DROP CONSTRAINT ${PARTICIPANT_CHILD_KEY_CHECK}`);
    await schema.execute(`ALTER TABLE memberships DROP COLUMN ${CHILD_IDENTITY_KEY_COLUMN}`);
    return;
  }
  await rebuildSqliteMemberships(schema, {
    definitions: MEMBERSHIP_COLUMN_DEFINITIONS_V005,
    columns: MEMBERSHIP_COLUMNS_V005,
  });
}

export const addRosterNameKeys: MigrationEntry = {
  version: "020_add_roster_name_keys",
  migration: {
    up: async (schema) => {
      await schema.execute(
        `ALTER TABLE guardian_relationships ADD COLUMN ${GUARDIAN_NAME_KEY_COLUMN} TEXT`,
      );
      await schema.execute(`ALTER TABLE memberships ADD COLUMN ${CHILD_IDENTITY_KEY_COLUMN} TEXT`);
      await backfillRosterNameKeys(migrationConnection(schema));
      await requireParticipantChildKey(schema);
      await schema.execute(
        `CREATE UNIQUE INDEX ${GUARDIAN_NAME_KEY_INDEX} ON guardian_relationships (participant_id, relationship, ${GUARDIAN_NAME_KEY_COLUMN}) WHERE status = 'active'`,
      );
      await schema.execute(
        `CREATE UNIQUE INDEX ${CHILD_IDENTITY_KEY_INDEX} ON memberships (season_id, ${CHILD_IDENTITY_KEY_COLUMN}) WHERE status = 'active' AND member_kind = 'participant'`,
      );
    },
    down: async (schema) => {
      await schema.execute(`DROP INDEX ${CHILD_IDENTITY_KEY_INDEX}`);
      await schema.execute(`DROP INDEX ${GUARDIAN_NAME_KEY_INDEX}`);
      await dropParticipantChildKey(schema);
      await schema.execute(
        `ALTER TABLE guardian_relationships DROP COLUMN ${GUARDIAN_NAME_KEY_COLUMN}`,
      );
    },
  },
};

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/**
 * Whether `error` is a UNIQUE violation of one of the two name-key indexes.
 * SQLite names the indexed columns in its message; Postgres names the index,
 * and both index names contain their key column's name.
 */
export function isRosterNameKeyConflict(error: unknown): boolean {
  return errorChain(error).some((link) => {
    if (!(link instanceof Error)) return false;
    const text = `${link.message} ${String((link as { constraint?: unknown }).constraint ?? "")}`;
    const unique = /unique/iu.test(text) || (link as { code?: unknown }).code === "23505";
    return (
      unique &&
      (text.includes(GUARDIAN_NAME_KEY_COLUMN) || text.includes(CHILD_IDENTITY_KEY_COLUMN))
    );
  });
}

const POSTGRES_DEADLOCK_DETECTED = "40P01";

/** Whether Postgres aborted this transaction to break a deadlock. */
export function isDeadlock(error: unknown): boolean {
  return errorChain(error).some(
    (link) =>
      typeof link === "object" &&
      link !== null &&
      (link as { code?: unknown }).code === POSTGRES_DEADLOCK_DETECTED,
  );
}

/**
 * Run a roster write transaction behind the name-key indexes. When a
 * concurrent write won an index, the transaction runs again up to `retries`
 * times, so its own JS duplicate check sees the winner and gives the answer a
 * sequential request gets. A conflict that is still there after that becomes
 * `conflict`, never a 500. With `deadlocks`, a Postgres deadlock abort (two
 * writes that each wait on the other's key) is treated the same way.
 */
export async function withRosterNameKeyBackstop<T, C>(
  run: () => Promise<T>,
  options: { readonly retries: number; readonly conflict: C; readonly deadlocks?: boolean },
): Promise<T | C> {
  const isRace = (error: unknown) =>
    isRosterNameKeyConflict(error) || (options.deadlocks === true && isDeadlock(error));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRace(error)) throw error;
      if (attempt >= options.retries) return options.conflict;
    }
  }
}
