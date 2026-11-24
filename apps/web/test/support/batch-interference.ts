import type { SqlDatabase } from "@lesto/db";

interface PendingInterference {
  readonly sqlFragment: string;
  readonly write: (sql: SqlDatabase) => Promise<void>;
}

/**
 * Wraps a SQLite handle so a test can land a competing write between a
 * handler's reads and its guarded batch: the next batch whose SQL contains
 * `sqlFragment` first runs `write` on the unwrapped handle.
 */
export function batchInterference(sql: SqlDatabase) {
  let pending: PendingInterference | undefined;
  let fired = 0;

  const wrapped: SqlDatabase = {
    ...(sql.dialect === undefined ? {} : { dialect: sql.dialect }),
    exec: (text) => sql.exec(text),
    prepare: (text) => sql.prepare(text),
    transaction: (fn) => sql.transaction(fn),
    batch: async (statements) => {
      const interference = pending;
      if (
        interference !== undefined &&
        statements.some((statement) => statement.sql.includes(interference.sqlFragment))
      ) {
        pending = undefined;
        fired += 1;
        await interference.write(sql);
      }
      return sql.batch(statements);
    },
  };

  return {
    sql: wrapped,
    beforeNextBatch(sqlFragment: string, write: PendingInterference["write"]) {
      pending = { sqlFragment, write };
    },
    firedCount: () => fired,
    reset() {
      pending = undefined;
      fired = 0;
    },
  };
}
