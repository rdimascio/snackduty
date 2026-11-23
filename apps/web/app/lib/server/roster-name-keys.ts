/**
 * The stored roster name keys and the partial UNIQUE indexes that enforce the
 * two roster duplicate invariants in the database (people-identity.ts has the
 * rule and why it is never identity proof).
 *
 *   - `guardian_relationships.guardian_name_key`: the normalized display name of
 *     a PLACEHOLDER guardian (a typed-in Person with no Account). Unique per
 *     participant + relationship among active links.
 *   - `memberships.child_identity_key`: `childIdentityKey` of the rostered
 *     child. Unique per season among active participant memberships.
 *
 * SQLite and Postgres cannot compute the Unicode normalization, so the key is
 * computed in JS on every write and by the JS backfill in this migration.
 */

import type { MigrationEntry } from "@lesto/migrate";
import { z } from "zod";

import { childIdentityKey, normalizeDisplayName } from "./people-identity";

export const GUARDIAN_NAME_KEY_COLUMN = "guardian_name_key";
export const CHILD_IDENTITY_KEY_COLUMN = "child_identity_key";
export const GUARDIAN_NAME_KEY_INDEX = "guardian_relationships_active_guardian_name_key_idx";
export const CHILD_IDENTITY_KEY_INDEX = "memberships_active_child_identity_key_idx";

export const ROSTER_NAME_KEY_CONFLICT = "ROSTER_NAME_KEY_CONFLICT";

/**
 * The stored guardian key. Only a placeholder guardian gets one: an
 * account-bound link (invitation acceptance) is never judged by name.
 */
export const ACCOUNT_BOUND_GUARDIAN_NAME_KEY = null;

export function guardianNameKey(guardian: {
  readonly displayName: string;
  readonly hasAccount: boolean;
}): string | null {
  return guardian.hasAccount
    ? ACCOUNT_BOUND_GUARDIAN_NAME_KEY
    : normalizeDisplayName(guardian.displayName);
}

/** Existing rows break an index the migration is about to create. */
export class RosterNameKeyConflictError extends Error {
  readonly code = ROSTER_NAME_KEY_CONFLICT;

  constructor(
    readonly guardianConflicts: number,
    readonly childConflicts: number,
  ) {
    super(
      `${ROSTER_NAME_KEY_CONFLICT}: ${guardianConflicts} duplicate active guardian group(s) and ` +
        `${childConflicts} duplicate active child group(s) already exist. ` +
        "Archive or fix those rows by hand, then run the migration again. No row was changed.",
    );
    this.name = "RosterNameKeyConflictError";
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

function conflictGroups(scopes: readonly (readonly string[])[]): number {
  const counts = new Map<string, number>();
  for (const scope of scopes) {
    const scopeKey = JSON.stringify(scope);
    counts.set(scopeKey, (counts.get(scopeKey) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
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
    )
    .map((row) => ({
      ...row,
      key: guardianNameKey({ displayName: row.display_name, hasAccount: row.account_id !== null }),
    }));

  const childRows = z
    .array(childRowSchema)
    .parse(
      await sql
        .prepare(
          "SELECT membership.id, membership.season_id, membership.status, child.display_name, participant.birth_date FROM memberships membership JOIN participants participant ON participant.id = membership.member_participant_id JOIN people child ON child.id = participant.person_id WHERE membership.member_kind = 'participant'",
        )
        .all(),
    )
    .map((row) => ({
      ...row,
      key: childIdentityKey({ displayName: row.display_name, birthDate: row.birth_date }),
    }));

  const guardianConflicts = conflictGroups(
    guardianRows.flatMap((row) =>
      row.status === ACTIVE && row.key !== null
        ? [[row.participant_id, row.relationship, row.key]]
        : [],
    ),
  );
  const childConflicts = conflictGroups(
    childRows.flatMap((row) => (row.status === ACTIVE ? [[row.season_id, row.key]] : [])),
  );
  if (guardianConflicts > 0 || childConflicts > 0) {
    throw new RosterNameKeyConflictError(guardianConflicts, childConflicts);
  }

  for (const row of guardianRows) {
    await sql
      .prepare(`UPDATE guardian_relationships SET ${GUARDIAN_NAME_KEY_COLUMN} = ? WHERE id = ?`)
      .run([row.key, row.id]);
  }
  for (const row of childRows) {
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

export const addRosterNameKeys: MigrationEntry = {
  version: "020_add_roster_name_keys",
  migration: {
    up: async (schema) => {
      await schema.execute(
        `ALTER TABLE guardian_relationships ADD COLUMN ${GUARDIAN_NAME_KEY_COLUMN} TEXT`,
      );
      await schema.execute(`ALTER TABLE memberships ADD COLUMN ${CHILD_IDENTITY_KEY_COLUMN} TEXT`);
      await backfillRosterNameKeys(migrationConnection(schema));
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
      await schema.execute(`ALTER TABLE memberships DROP COLUMN ${CHILD_IDENTITY_KEY_COLUMN}`);
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

/**
 * Run a roster write transaction behind the name-key indexes. When a
 * concurrent write won an index, the transaction runs again up to `retries`
 * times, so its own JS duplicate check sees the winner and gives the answer a
 * sequential request gets. A conflict that is still there after that becomes
 * `conflict`, never a 500.
 */
export async function withRosterNameKeyBackstop<T, C>(
  run: () => Promise<T>,
  options: { readonly retries: number; readonly conflict: C },
): Promise<T | C> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRosterNameKeyConflict(error)) throw error;
      if (attempt >= options.retries) return options.conflict;
    }
  }
}
