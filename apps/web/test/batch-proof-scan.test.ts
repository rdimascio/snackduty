import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
const SOURCE_FILE = /\.tsx?$/u;
const TEST_FILE = /\.test\.tsx?$/u;
const PROOF_REFERENCE = /\b(?:proofs|proofGuard|abortUnless)\b/u;

interface AllowedSites {
  readonly count: number;
  readonly reason: string;
}

/** Files whose `.batch(` calls may run without a proof, and why. Paths are relative to `app/`. */
const UNGUARDED_BATCH_ALLOWLIST: Readonly<Record<string, AllowedSites>> = {
  "coach/lesson-requests.ts": { count: 1, reason: "public lesson request form; no actor" },
  "lib/server/authentication.ts": {
    count: 1,
    reason: "Apple sign-in challenge before sign-in; no actor",
  },
  "lib/server/invitations.ts": {
    count: 2,
    reason: "still inside transaction(); remove when the invitations slice lands",
  },
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

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly method: "batch" | "transaction";
  readonly arguments: string;
}

async function appSourceFiles(): Promise<string[]> {
  const entries = await readdir(APP_DIR, { recursive: true });
  return entries
    .filter((entry) => SOURCE_FILE.test(entry) && !TEST_FILE.test(entry))
    .map((entry) => join(APP_DIR, entry))
    .toSorted();
}

function callSites(path: string, text: string): CallSite[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const file = relative(APP_DIR, path).split(sep).join("/");
  const sites: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "batch" || method === "transaction") {
        const { line } = source.getLineAndCharacterOfPosition(node.expression.name.getStart());
        sites.push({
          file,
          line: line + 1,
          method,
          arguments: node.arguments.map((argument) => argument.getText(source)).join(", "),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

async function appCallSites(): Promise<CallSite[]> {
  const sites: CallSite[] = [];
  for (const path of await appSourceFiles()) {
    sites.push(...callSites(path, await readFile(path, "utf8")));
  }
  return sites;
}

function countByFile(sites: readonly CallSite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return counts;
}

const location = (site: CallSite) => `app/${site.file}:${site.line}`;

describe("D1 write sites in app/", () => {
  it("finds the batch and transaction calls it scans", async () => {
    const sites = await appCallSites();

    expect(sites.some((site) => site.method === "batch")).toBe(true);
    expect(sites.some((site) => site.method === "transaction")).toBe(true);
  });

  it("gives every .batch( call a proof in its arguments, unless its file is allowlisted", async () => {
    const unguarded = (await appCallSites()).filter(
      (site) => site.method === "batch" && !PROOF_REFERENCE.test(site.arguments),
    );
    const counts = countByFile(unguarded);

    const offending = unguarded
      .filter((site) => counts[site.file] !== UNGUARDED_BATCH_ALLOWLIST[site.file]?.count)
      .map((site) => `${location(site)} batch without proofs, proofGuard or abortUnless`);
    const stale = Object.entries(UNGUARDED_BATCH_ALLOWLIST)
      .filter(([file, allowed]) => (counts[file] ?? 0) < allowed.count)
      .map(([file, allowed]) => `app/${file} allows ${allowed.count}, has ${counts[file] ?? 0}`);

    expect(offending).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("adds no .transaction( call beyond today's remaining sites", async () => {
    const transactions = (await appCallSites()).filter((site) => site.method === "transaction");
    const counts = countByFile(transactions);

    const added = transactions
      .filter((site) => counts[site.file]! > (REMAINING_TRANSACTIONS[site.file] ?? 0))
      .map((site) => `${location(site)} transaction; use a guarded batch`);
    const lowered = Object.entries(REMAINING_TRANSACTIONS)
      .filter(([file, frozen]) => (counts[file] ?? 0) < frozen)
      .map(([file, frozen]) => `app/${file} froze ${frozen}, has ${counts[file] ?? 0}; lower it`);

    expect(added).toEqual([]);
    expect(lowered).toEqual([]);
  });
});
