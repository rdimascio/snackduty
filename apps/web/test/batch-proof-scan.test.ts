import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  scanWriteSites,
  staleAllowlistEntries,
  transactionDrift,
  unguardedWrites,
} from "./support/d1-write-scan";
import type { BatchAllowlist, WriteSite } from "./support/d1-write-scan";

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
const SOURCE_FILE = /\.tsx?$/u;
const TEST_FILE = /\.test\.tsx?$/u;

/** One entry per `.batch(` site that may run without a proof: `file#enclosing function` to why. */
const UNGUARDED_BATCH_ALLOWLIST: BatchAllowlist = {
  "coach/lesson-requests.ts#record": "public lesson request form; no actor",
  "lib/server/authentication.ts#challenge": "Apple challenge before sign-in; no actor",
  "lib/server/invitations.ts#createInvitation":
    "still inside transaction(); remove when the invitations slice lands",
  "lib/server/invitations.ts#resendInvitation":
    "still inside transaction(); remove when the invitations slice lands",
};

/**
 * Today's `.transaction(` calls, which D1 cannot run, per file relative to
 * `app/`. A port to a guarded batch lowers a count; nothing may raise one.
 */
const REMAINING_TRANSACTIONS: Readonly<Record<string, number>> = {
  "dev/seed-database.ts": 1,
  "dev/skill-events.ts": 1,
  "lessons/lessons.ts": 1,
  "lib/server/authentication.ts": 1,
  "lib/server/calendar-feeds.ts": 2,
  "lib/server/email-sign-in.ts": 2,
  "lib/server/erasure.ts": 2,
  "lib/server/events.ts": 2,
  "lib/server/identity.ts": 1,
  "lib/server/invitation-outbox.ts": 1,
  "lib/server/invitations.ts": 4,
  "lib/server/roster-import.ts": 1,
  "lib/server/roster.ts": 2,
  "lib/server/teams.ts": 3,
};

async function appWriteSites(): Promise<WriteSite[]> {
  const entries = await readdir(APP_DIR, { recursive: true });
  const files = entries
    .filter((entry) => SOURCE_FILE.test(entry) && !TEST_FILE.test(entry))
    .toSorted();
  const sites: WriteSite[] = [];
  for (const entry of files) {
    const text = await readFile(join(APP_DIR, entry), "utf8");
    sites.push(
      ...scanWriteSites(relative(APP_DIR, join(APP_DIR, entry)).split(sep).join("/"), text),
    );
  }
  return sites;
}

describe("D1 write sites in app/", () => {
  it("gives every batch a proof, unless the site is allowlisted", async () => {
    expect(unguardedWrites(await appWriteSites(), UNGUARDED_BATCH_ALLOWLIST)).toEqual([]);
  });

  it("keeps no stale allowlist entry", async () => {
    expect(staleAllowlistEntries(await appWriteSites(), UNGUARDED_BATCH_ALLOWLIST)).toEqual([]);
  });

  it("adds no .transaction( call beyond today's remaining sites", async () => {
    expect(transactionDrift(await appWriteSites(), REMAINING_TRANSACTIONS)).toEqual({
      added: [],
      lowered: [],
    });
  });
});

const FIXTURE = "fixture.ts";

function fixtureFindings(body: string, allowlist: BatchAllowlist = {}): string[] {
  return unguardedWrites(
    scanWriteSites(FIXTURE, `async function site(db) {\n${body}\n}`),
    allowlist,
  );
}

describe("the write scanner on fixture source", () => {
  it("accepts a single write whose arguments carry the proofs", () => {
    expect(fixtureFindings("await db.batch([claim(authorized.proofs)]);")).toEqual([]);
    expect(fixtureFindings("await db.batch([upsert([...authorized.proofs, extra])]);")).toEqual([]);
    expect(fixtureFindings("await db.batch([cancel(proofGuard(...proofs))]);")).toEqual([]);
  });

  it("accepts a batch that holds a direct abortUnless call", () => {
    expect(
      fixtureFindings("await db.batch([write(), abortUnless(proofGuard(...proofs))]);"),
    ).toEqual([]);
  });

  it("refuses a multi-statement batch whose proof sits in one statement only", () => {
    expect(
      fixtureFindings("await db.batch([update(authorized.proofs), insertAudit(), deleteRows()]);"),
    ).toEqual(["app/fixture.ts:2 unguarded batch in site"]);
  });

  it("refuses a proof named only in a comment", () => {
    expect(fixtureFindings("await db.batch([/* proofs */ write()]);")).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
    ]);
  });

  it("refuses a proof named only in a string", () => {
    expect(fixtureFindings('await db.batch([log("no proofs here"), write()]);')).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
    ]);
  });

  it("refuses a proof that is only evaluated and thrown away", () => {
    expect(fixtureFindings("await db.batch([write(), ...(void proofs, [])]);")).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
    ]);
    expect(fixtureFindings("await db.batch([write(void proofs)]);")).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
    ]);
  });

  it("refuses a batch whose statements are not an array literal", () => {
    expect(fixtureFindings("await db.batch(statements);")).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
    ]);
  });

  it("accepts runGuardedBatch with a proof guard and refuses it without one", () => {
    expect(
      fixtureFindings("await runGuardedBatch(db, proofGuard(...authorized.proofs), [write()]);"),
    ).toEqual([]);
    expect(fixtureFindings("await runGuardedBatch(db, guard, [write()]);")).toEqual([
      "app/fixture.ts:2 unguarded guarded-runner in site",
    ]);
    expect(fixtureFindings("await runGuardedBatch(db);")).toEqual([
      "app/fixture.ts:2 unguarded guarded-runner in site",
    ]);
  });

  it("fails closed on indirect batch and transaction references", () => {
    const indirect = [
      'await db["batch"]([write()]);',
      'await db["transaction"](async () => {});',
      "const { batch } = db;",
      "const { transaction: run } = db;",
      "const bound = db.batch.bind(db);",
      "await db.transaction.call(db, async () => {});",
      "const alias = db.batch;",
    ];
    for (const body of indirect) {
      expect(fixtureFindings(body)).toEqual(["app/fixture.ts:2 unguarded indirect in site"]);
    }
  });

  it("allowlists one site per entry and reports a site without one", () => {
    const allowlist = { "fixture.ts#site": "fixture reason" };

    expect(fixtureFindings("await db.batch([write()]);", allowlist)).toEqual([]);
    expect(
      fixtureFindings("await db.batch([write()]);\nawait db.batch([other()]);", allowlist),
    ).toEqual([
      "app/fixture.ts:2 unguarded batch in site",
      "app/fixture.ts:3 unguarded batch in site",
    ]);
  });

  it("flags an allowlist entry that matches no unguarded batch", () => {
    const sites = scanWriteSites(
      FIXTURE,
      "async function site(db) {\nawait db.batch([claim(proofs)]);\n}",
    );

    expect(staleAllowlistEntries(sites, { "fixture.ts#site": "fixture reason" })).toEqual([
      "fixture.ts#site",
    ]);
  });

  it("reports a transaction past the frozen count with its location, and a count to lower", () => {
    const sites = scanWriteSites(
      FIXTURE,
      "async function site(db) {\nawait db.transaction(a);\nawait db.transaction(b);\n}",
    );

    expect(transactionDrift(sites, { [FIXTURE]: 1 }).added).toEqual([
      "app/fixture.ts:2 transaction in site",
      "app/fixture.ts:3 transaction in site",
    ]);
    expect(transactionDrift(sites, { [FIXTURE]: 3 }).lowered).toEqual([
      "app/fixture.ts froze 3, has 2",
    ]);
  });
});
