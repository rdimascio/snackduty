import { installSessionSchema } from "@lesto/auth";
import { createDb, rawChanges } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  abortUnless,
  BATCH_GUARD_TABLE,
  EvidenceChangedError,
  isBatchGuardAbort,
  proofGuard,
  runGuardedBatch,
} from "../app/lib/server/authorization";
import type { SqlGuard } from "../app/lib/server/authorization";
import { applicationMigrations } from "../app/lib/server/composition";

const NOW = "2026-11-24T12:00:00.000Z";
const PRESENT_PERSON = "person_batch_guard_present";
const ABSENT_PERSON = "person_batch_guard_absent";

let sql: SqlDatabase;
let db: Db;
let close: () => void;

function personExists(id: string): SqlGuard {
  return proofGuard([{ sql: "EXISTS (SELECT 1 FROM people WHERE people.id = ?)", params: [id] }]);
}

const holds = personExists(PRESENT_PERSON);
const fails = personExists(ABSENT_PERSON);

function insertPerson(id: string) {
  return rawChanges(
    "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, "Batch guard adult", "active", NOW, NOW],
  );
}

async function count(statement: string, params: readonly unknown[] = []): Promise<number> {
  const row = (await sql.prepare(`SELECT COUNT(*) AS n FROM ${statement}`).get([...params])) as {
    n: number;
  };
  return row.n;
}

const peopleNamed = (id: string) => count("people WHERE id = ?", [id]);
const guardRows = () => count(BATCH_GUARD_TABLE);

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  sql = opened.db;
  close = opened.close;
  await installSessionSchema(sql);
  await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
  db = createDb(sql);
  await db.batch([insertPerson(PRESENT_PERSON)]);
});

afterAll(() => close());

describe("abortUnless", () => {
  it("lets the batch land and writes no guard row while the guard holds", async () => {
    await db.batch([abortUnless(holds), insertPerson("person_batch_guard_lands")]);

    expect(await peopleNamed("person_batch_guard_lands")).toBe(1);
    expect(await guardRows()).toBe(0);
  });

  it("rolls back the writes before and after it when the guard fails", async () => {
    const error = await failure(() =>
      db.batch([
        insertPerson("person_batch_guard_before"),
        abortUnless(fails),
        insertPerson("person_batch_guard_after"),
      ]),
    );

    expect(isBatchGuardAbort(error)).toBe(true);
    expect(await peopleNamed("person_batch_guard_before")).toBe(0);
    expect(await peopleNamed("person_batch_guard_after")).toBe(0);
    expect(await guardRows()).toBe(0);
  });
});

describe("runGuardedBatch", () => {
  it("returns only the results of the writes when the guard holds", async () => {
    const results = await runGuardedBatch(db, holds, [insertPerson("person_batch_guard_run")]);

    expect(results).toEqual([{ changes: 1 }]);
    expect(await peopleNamed("person_batch_guard_run")).toBe(1);
  });

  it("throws EvidenceChangedError and writes nothing when the guard fails", async () => {
    const error = await failure(() =>
      runGuardedBatch(db, fails, [insertPerson("person_batch_guard_refused")]),
    );

    expect(error).toBeInstanceOf(EvidenceChangedError);
    expect(isBatchGuardAbort((error as EvidenceChangedError).cause)).toBe(true);
    expect(await peopleNamed("person_batch_guard_refused")).toBe(0);
  });

  it("rethrows any other batch failure unchanged", async () => {
    const error = await failure(() => runGuardedBatch(db, holds, [insertPerson(PRESENT_PERSON)]));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EvidenceChangedError);
    expect(isBatchGuardAbort(error)).toBe(false);
  });
});

function wrapped(cause: Error): Error {
  return new Error("batch failed", { cause });
}

describe("isBatchGuardAbort on each driver's error shape", () => {
  it("matches the SQLite and D1 NOT NULL message on the guard table", () => {
    expect(isBatchGuardAbort(new Error("NOT NULL constraint failed: batch_guard.ok"))).toBe(true);
    expect(
      isBatchGuardAbort(
        wrapped(
          new Error("D1_ERROR: NOT NULL constraint failed: batch_guard.ok: SQLITE_CONSTRAINT"),
        ),
      ),
    ).toBe(true);
  });

  it("matches the Postgres not-null violation on the guard table", () => {
    const postgres = Object.assign(
      new Error('null value in column "ok" of relation "batch_guard" violates not-null constraint'),
      { code: "23502", table: "batch_guard", column: "ok" },
    );

    expect(isBatchGuardAbort(postgres)).toBe(true);
    expect(isBatchGuardAbort(wrapped(postgres))).toBe(true);
  });

  it("ignores a NOT NULL failure on another table and other constraint failures", () => {
    expect(isBatchGuardAbort(new Error("NOT NULL constraint failed: people.status"))).toBe(false);
    expect(
      isBatchGuardAbort(
        Object.assign(
          new Error(
            'null value in column "status" of relation "people" violates not-null constraint',
          ),
          { code: "23502", table: "people", column: "status" },
        ),
      ),
    ).toBe(false);
    expect(isBatchGuardAbort(new Error("UNIQUE constraint failed: people.id"))).toBe(false);
    expect(isBatchGuardAbort("NOT NULL constraint failed: batch_guard.ok")).toBe(false);
  });
});
