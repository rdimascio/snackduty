/**
 * Bulk roster entry from a CSV, as PREVIEW-then-COMMIT.
 *
 * Two endpoints, both owner/manage-authorized through `manageableActiveTeam`
 * (so a read-only adult member is hidden behind the same 404 a stranger gets):
 *
 *   POST /api/teams/:teamId/seasons/:seasonId/roster/import/preview
 *     Body `{ csv: string }`. Parses, maps the header, validates every row, and
 *     answers a per-row VERDICT — writing NOTHING. A file-level problem (an
 *     unreadable CSV, no child-name column, a column that could hold a child's
 *     email address) is a 422 refusal of the whole file.
 *
 *   POST /api/teams/:teamId/seasons/:seasonId/roster/import
 *     Body `{ rows: ImportRow[] }` — the rows the preview returned. Creates the
 *     children and their guardians in ONE transaction.
 *
 * IDEMPOTENCE, stated plainly: the commit holds no server-side draft and issues
 * no ticket. It re-derives every child's identity key (people-identity.ts)
 * inside its transaction, against BOTH the season's existing roster and the rows
 * already processed in this same request, and SKIPS any row that matches. A
 * double-submit therefore finds, on its second pass, that every child it created
 * on the first pass is already rostered — so it creates nothing and answers 200
 * with `created: 0` instead of 201. No second roster, no unique index, no token
 * to expire: the duplicate rule the manager already reviewed in the preview is
 * the same rule that makes a replay a no-op.
 *
 * PRIVACY: a CSV cell may hold a child's name or birth date, so no refusal from
 * this module ever quotes one. Every file-level and row-level problem is
 * reported as a CODE plus a POSITION (source line, column number, field path).
 * Values travel only in the 200 preview body, back to the authorized manager who
 * just uploaded them — and only for rows that are eligible to be committed, so
 * even that body carries nothing for a row the manager cannot act on.
 */

import type { SessionService as Sessions } from "./application-contracts";
import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema } from "@snackday/domain";
import { z } from "zod";

import { isBlankRecord, parseCsv } from "./csv";
import type { CsvRecord } from "./csv";
import { authenticatedAdult } from "./identity";
import { childIdentityKey } from "./people-identity";
import {
  addParticipantInputSchema,
  attachGuardianEdge,
  attachGuardianInputSchema,
  createRosteredParticipant,
  DEFAULT_GUARDIAN_PERMISSIONS,
  hasDuplicateActiveGuardian,
  projectGuardian,
  projectParticipant,
  seasonChildIdentityKeys,
} from "./roster";
import { manageableActiveTeam, seasons } from "./teams";

/** How many guardian slots one CSV row may carry. */
export const MAX_GUARDIANS_PER_ROW = 4;
/** How many children one commit may create. Preview refuses a longer file. */
export const MAX_IMPORT_ROWS = 200;

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;

/**
 * One row's committable shape. The child half IS the single-add endpoint's
 * schema and the guardian half IS the attach endpoint's, minus `permissions` —
 * an imported guardian always gets the shared default, so a bulk upload can
 * never widen a grant the single-add path would not have given.
 */
const importGuardianSchema = attachGuardianInputSchema.omit({ permissions: true });

export const importRowSchema = addParticipantInputSchema.extend({
  guardians: z.array(importGuardianSchema).max(MAX_GUARDIANS_PER_ROW),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importPreviewInputSchema = z.strictObject({ csv: z.string() });

/**
 * The commit body is validated in two steps on purpose: this schema checks only
 * the CONTAINER (an array, bounded), and each row is then parsed individually so
 * a bad row becomes a coded, value-free 422 instead of a framework validation
 * error carrying the raw input.
 */
export const importCommitInputSchema = z.strictObject({
  rows: z.array(z.unknown()).max(MAX_IMPORT_ROWS),
});

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

/**
 * A header cell reduced to its comparable form: lower-cased with every
 * non-alphanumeric character dropped, so `Guardian 1 Name`, `guardian_1_name`,
 * and `Guardian1Name` are one column.
 */
function normalizeHeader(header: string): string {
  return header
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "");
}

const CHILD_NAME_HEADERS = new Set([
  "childname",
  "child",
  "participantname",
  "participant",
  "playername",
  "player",
  "name",
]);
const BIRTH_DATE_HEADERS = new Set(["birthdate", "dob", "dateofbirth", "birthday"]);

/** The header vocabulary echoed back with a refusal, so the fix is obvious. */
export const EXPECTED_IMPORT_HEADERS = [
  "child_name",
  "birth_date (optional, YYYY-MM-DD)",
  "guardian1_name",
  "guardian1_relationship (parent | guardian | caregiver | other)",
  "guardian2_name",
  "guardian2_relationship",
] as const;

/**
 * A column whose name is qualified with an explicit ADULT ROLE is allowed to
 * exist (and is then ignored — Snackday stores no adult email yet). Anything
 * else that looks like an address is treated as possibly a CHILD's and refuses
 * the file: a header alone cannot prove whose address a column holds, and for a
 * child the only acceptable default is refusal. Deliberately NOT on this list:
 * `contact`, which reads as an adult's in a roster export but is not a role and
 * cannot be relied on to be one.
 */
const ADULT_QUALIFIERS = ["guardian", "parent", "caregiver", "adult"] as const;

function looksLikeEmailColumn(normalized: string): boolean {
  return normalized.includes("email") || normalized.includes("mail");
}

function isAdultQualified(normalized: string): boolean {
  return ADULT_QUALIFIERS.some((qualifier) => normalized.startsWith(qualifier));
}

function guardianSlot(normalized: string, suffix: readonly string[]): number | undefined {
  for (const prefix of ["guardian", "parent"]) {
    for (const tail of suffix) {
      if (!normalized.startsWith(prefix) || !normalized.endsWith(tail)) continue;
      const middle = normalized.slice(prefix.length, normalized.length - tail.length);
      if (middle === "" && tail !== "") return 1;
      if (/^\d+$/u.test(middle)) return Number.parseInt(middle, 10);
    }
  }
  return undefined;
}

interface HeaderMapping {
  readonly childName: number;
  readonly birthDate: number | undefined;
  /** Slot number → the column indexes carrying that guardian's name/label. */
  readonly guardians: readonly { slot: number; name: number; relationship: number | undefined }[];
  /** 1-based positions of columns this import does not read. */
  readonly ignoredColumns: readonly number[];
}

export type ImportRejection = {
  readonly error: string;
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  readonly expectedColumns?: readonly string[];
};

type HeaderResult =
  | { readonly ok: true; readonly mapping: HeaderMapping }
  | { readonly ok: false; readonly rejection: ImportRejection };

function mapHeader(record: CsvRecord): HeaderResult {
  let childName: number | undefined;
  let birthDate: number | undefined;
  const guardianNames = new Map<number, number>();
  const guardianRelationships = new Map<number, number>();
  const ignoredColumns: number[] = [];

  for (const [index, raw] of record.fields.entries()) {
    const normalized = normalizeHeader(raw);
    const column = index + 1;

    if (looksLikeEmailColumn(normalized) && !isAdultQualified(normalized)) {
      // The product invariant, enforced at the door: a child has no email
      // address in Snackday, so a file that might carry one is never read at
      // all. The column POSITION is named; its text never is.
      return {
        ok: false,
        rejection: {
          error:
            "This file has a column that may hold a child's email address. Children never have " +
            "an email address in Snackday — remove that column and upload again.",
          code: "child_email_column",
          column,
          expectedColumns: EXPECTED_IMPORT_HEADERS,
        },
      };
    }

    if (normalized === "" || looksLikeEmailColumn(normalized)) {
      ignoredColumns.push(column);
      continue;
    }
    if (childName === undefined && CHILD_NAME_HEADERS.has(normalized)) {
      childName = index;
      continue;
    }
    if (birthDate === undefined && BIRTH_DATE_HEADERS.has(normalized)) {
      birthDate = index;
      continue;
    }

    const relationshipSlot = guardianSlot(normalized, ["relationship", "rel", "role"]);
    if (relationshipSlot !== undefined && !guardianRelationships.has(relationshipSlot)) {
      guardianRelationships.set(relationshipSlot, index);
      continue;
    }
    const nameSlot = guardianSlot(normalized, ["name", ""]);
    if (nameSlot !== undefined && !guardianNames.has(nameSlot)) {
      guardianNames.set(nameSlot, index);
      continue;
    }

    ignoredColumns.push(column);
  }

  if (childName === undefined) {
    return {
      ok: false,
      rejection: {
        error: "This file has no column naming the child. Add a `child_name` column and try again.",
        code: "missing_child_name_column",
        line: record.line,
        expectedColumns: EXPECTED_IMPORT_HEADERS,
      },
    };
  }

  const guardians = [...guardianNames.entries()]
    .map(([slot, name]) => ({ slot, name, relationship: guardianRelationships.get(slot) }))
    .filter((guardian) => guardian.slot <= MAX_GUARDIANS_PER_ROW)
    .sort((left, right) => left.slot - right.slot);

  return { ok: true, mapping: { childName, birthDate, guardians, ignoredColumns } };
}

// ---------------------------------------------------------------------------
// Row verdicts
// ---------------------------------------------------------------------------

export type RowVerdict = "valid" | "duplicate_in_file" | "duplicate_in_roster" | "invalid";

/** A validation problem, as a FIELD PATH and a CODE — never a value. */
export interface RowIssue {
  readonly field: string;
  readonly code: string;
}

export interface PreviewRow {
  /** 1-based source line the row started on, so a manager can find it. */
  readonly line: number;
  readonly verdict: RowVerdict;
  /** The line this row duplicates, for a `duplicate_in_file` verdict. */
  readonly duplicateOfLine?: number;
  readonly issues?: readonly RowIssue[];
  /** Present only for rows that could be committed — never for `invalid`. */
  readonly row?: ImportRow;
}

const RELATIONSHIP_LABELS = new Set(guardianRelationshipSchema.shape.relationship.options);
// A guardian named without a label is a guardian, literally: the neutral member
// of the enum, chosen rather than guessed, and shown in the preview before
// anything is written.
const DEFAULT_RELATIONSHIP = "guardian";

function cell(record: CsvRecord, index: number | undefined): string {
  return index === undefined ? "" : (record.fields[index] ?? "").trim();
}

function issuesOf(error: z.ZodError): RowIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length === 0 ? "row" : issue.path.join("."),
    code: issue.code,
  }));
}

/**
 * One CSV record read as a candidate row. Structural problems the record shape
 * itself creates (a relationship label we do not know, a guardian label with no
 * name) become issues here; everything else is decided by the shared Zod
 * schemas, so import and single-add cannot disagree about what is valid.
 */
function readRow(record: CsvRecord, mapping: HeaderMapping): PreviewRow {
  const issues: RowIssue[] = [];
  const guardians: { displayName: string; relationship: string }[] = [];

  for (const [slotIndex, guardian] of mapping.guardians.entries()) {
    const displayName = cell(record, guardian.name);
    const rawRelationship = cell(record, guardian.relationship).toLowerCase();
    if (displayName === "" && rawRelationship === "") continue;

    const field = `guardians.${slotIndex}`;
    if (displayName === "") {
      issues.push({ field: `${field}.displayName`, code: "required" });
      continue;
    }
    if (rawRelationship !== "" && !RELATIONSHIP_LABELS.has(rawRelationship as never)) {
      issues.push({ field: `${field}.relationship`, code: "unknown_relationship" });
      continue;
    }
    guardians.push({
      displayName,
      relationship: rawRelationship === "" ? DEFAULT_RELATIONSHIP : rawRelationship,
    });
  }

  const birthDate = cell(record, mapping.birthDate);
  const candidate = {
    displayName: cell(record, mapping.childName),
    ...(birthDate === "" ? {} : { birthDate }),
    guardians,
  };
  const parsed = importRowSchema.safeParse(candidate);
  if (!parsed.success) issues.push(...issuesOf(parsed.error));

  if (issues.length > 0 || !parsed.success) {
    return { line: record.line, verdict: "invalid", issues };
  }

  return { line: record.line, verdict: "valid", row: parsed.data };
}

export interface PreviewSummary {
  readonly rows: number;
  readonly valid: number;
  readonly duplicateInFile: number;
  readonly duplicateInRoster: number;
  readonly invalid: number;
}

export interface ImportPreview {
  readonly summary: PreviewSummary;
  readonly rows: readonly PreviewRow[];
  readonly ignoredColumns: readonly number[];
}

type PreviewResult =
  | { readonly ok: true; readonly preview: ImportPreview }
  | { readonly ok: false; readonly rejection: ImportRejection };

/**
 * The whole read-only half: text in, verdicts out, no database access except the
 * set of children already on the roster (which the caller supplies, having
 * already authorized the team and season).
 */
export function previewImport(csv: string, existingKeys: ReadonlySet<string>): PreviewResult {
  const parsed = parseCsv(csv);
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: {
        error: parsed.error.message,
        code: parsed.error.code,
        ...(parsed.error.line === undefined ? {} : { line: parsed.error.line }),
        ...(parsed.error.field === undefined ? {} : { column: parsed.error.field }),
      },
    };
  }

  const records = parsed.records.filter((record) => !isBlankRecord(record));
  const [header, ...dataRecords] = records;
  if (header === undefined) {
    return {
      ok: false,
      rejection: {
        error: "This file has no rows. Export a header row plus one row per child.",
        code: "empty_file",
        expectedColumns: EXPECTED_IMPORT_HEADERS,
      },
    };
  }

  const mapped = mapHeader(header);
  if (!mapped.ok) return mapped;

  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      rejection: {
        error: `This file has more than the ${MAX_IMPORT_ROWS} children one import accepts. Split it and upload again.`,
        code: "too_many_rows",
      },
    };
  }

  const firstLineByKey = new Map<string, number>();
  const rows = dataRecords.map((record): PreviewRow => {
    const read = readRow(record, mapped.mapping);
    if (read.row === undefined) return read;

    const key = childIdentityKey(read.row);
    const firstLine = firstLineByKey.get(key);
    if (firstLine !== undefined) {
      return { ...read, verdict: "duplicate_in_file", duplicateOfLine: firstLine };
    }
    firstLineByKey.set(key, read.line);

    return existingKeys.has(key) ? { ...read, verdict: "duplicate_in_roster" } : read;
  });

  const count = (verdict: RowVerdict) => rows.filter((row) => row.verdict === verdict).length;

  return {
    ok: true,
    preview: {
      summary: {
        rows: rows.length,
        valid: count("valid"),
        duplicateInFile: count("duplicate_in_file"),
        duplicateInRoster: count("duplicate_in_roster"),
        invalid: count("invalid"),
      },
      rows,
      ignoredColumns: mapped.mapping.ignoredColumns,
    },
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** The team+season this import targets, or undefined — the 404-hiding seam. */
async function manageableSeason(tx: Db, c: { teamId: string; seasonId: string }, personId: string) {
  const team = await manageableActiveTeam(tx, c.teamId, personId);
  if (team === undefined) return undefined;

  const season = await tx
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, c.seasonId), eq(seasons.teamId, team.id)))
    .get();

  return season === undefined ? undefined : { team, season };
}

async function previewRosterImport(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/roster/import/preview">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(importPreviewInputSchema);
  const target = await manageableSeason(
    db,
    { teamId: c.param("teamId"), seasonId: c.param("seasonId") },
    identity.person.id,
  );
  if (target === undefined) return c.json(teamNotFound, 404);

  const existingKeys = await seasonChildIdentityKeys(db, target.team.id, target.season.id);
  const result = previewImport(input.csv, existingKeys);

  return result.ok ? c.json(result.preview) : c.json(result.rejection, 422);
}

export type CommitOutcome = "created" | "duplicate_in_payload" | "duplicate_in_roster";

interface CommitRow {
  readonly index: number;
  readonly outcome: CommitOutcome;
  readonly participant?: ReturnType<typeof projectParticipant>;
  readonly guardians?: readonly ReturnType<typeof projectGuardian>[];
}

async function commitRosterImport(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/roster/import">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(importCommitInputSchema);
  const parsedRows = input.rows.map((row) => importRowSchema.safeParse(row));
  const invalid = parsedRows.flatMap((parsed, index) =>
    parsed.success ? [] : [{ index, issues: issuesOf(parsed.error) }],
  );
  if (invalid.length > 0) {
    // Coded and positional: the caller learns WHICH row and WHICH field, and the
    // payload carries not one character of what those fields held.
    return c.json(
      {
        error: "Some rows are not valid. Preview the file again and commit the rows it returns.",
        code: "invalid_rows",
        rows: invalid,
      },
      422,
    );
  }
  const rows = parsedRows.flatMap((parsed) => (parsed.success ? [parsed.data] : []));

  const outcome = await db.transaction(async (tx) => {
    const target = await manageableSeason(
      tx,
      { teamId: c.param("teamId"), seasonId: c.param("seasonId") },
      identity.person.id,
    );
    if (target === undefined) return null;

    // Re-derived INSIDE the transaction, so a replay sees what the first pass
    // wrote and a concurrent single-add is honored too.
    const keys = await seasonChildIdentityKeys(tx, target.team.id, target.season.id);
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const results: CommitRow[] = [];

    for (const [index, row] of rows.entries()) {
      const key = childIdentityKey(row);
      if (seen.has(key)) {
        results.push({ index, outcome: "duplicate_in_payload" });
        continue;
      }
      seen.add(key);
      if (keys.has(key)) {
        results.push({ index, outcome: "duplicate_in_roster" });
        continue;
      }

      const { row: participantRow, person } = await createRosteredParticipant(
        tx,
        { teamId: target.team.id, seasonId: target.season.id },
        row,
        now,
      );
      keys.add(key);

      const guardians = [];
      for (const guardian of row.guardians) {
        // The SAME invariant the single-add path enforces, so a row that names
        // one guardian twice attaches them once instead of conflicting.
        if (await hasDuplicateActiveGuardian(tx, participantRow.id, guardian)) continue;

        const attached = await attachGuardianEdge(
          tx,
          participantRow.id,
          { ...guardian, permissions: DEFAULT_GUARDIAN_PERMISSIONS },
          now,
        );
        guardians.push(projectGuardian(attached.edge, attached.person));
      }

      results.push({
        index,
        outcome: "created",
        participant: projectParticipant(participantRow, person),
        guardians,
      });
    }

    return results;
  });

  if (outcome === null) return c.json(teamNotFound, 404);

  const created = outcome.filter((row) => row.outcome === "created").length;

  // 201 only when something was actually created; a replay answers 200 with
  // `created: 0`, which is the idempotence contract made observable.
  return c.json(
    {
      summary: {
        requested: rows.length,
        created,
        skipped: outcome.length - created,
      },
      rows: outcome,
    },
    created > 0 ? 201 : 200,
  );
}

export function registerRosterImportRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .post("/api/teams/:teamId/seasons/:seasonId/roster/import/preview", (c) =>
      previewRosterImport(c, db, sessions),
    )
    .post("/api/teams/:teamId/seasons/:seasonId/roster/import", (c) =>
      commitRosterImport(c, db, sessions),
    );
}
