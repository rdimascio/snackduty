export type RosterPoster = (
  url: string,
  body: unknown,
) => Promise<{ readonly status: number; readonly json: unknown }>;

export const GUARDIAN_RELATIONSHIPS = ["parent", "guardian", "caregiver", "other"] as const;
export type GuardianRelationship = (typeof GUARDIAN_RELATIONSHIPS)[number];

export async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

function seasonPath(teamId: string, seasonId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/seasons/${encodeURIComponent(seasonId)}`;
}

export type ActionOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

const notAllowed = "You can't change this roster. Ask a team coach.";
const signedOut = "Your session ended. Sign in again and retry.";
const failed = "That did not save. Try again.";

function refusal(status: number, invalid: string): ActionOutcome {
  if (status === 401) return { ok: false, message: signedOut };
  if (status === 403 || status === 404) return { ok: false, message: notAllowed };
  if (status === 400 || status === 422) return { ok: false, message: invalid };
  return { ok: false, message: failed };
}

export interface NewParticipant {
  readonly displayName: string;
  readonly birthDate?: string;
}

export async function addParticipant(
  teamId: string,
  seasonId: string,
  input: NewParticipant,
  post: RosterPoster = postJson,
): Promise<ActionOutcome> {
  const displayName = input.displayName.trim();
  if (displayName === "") return { ok: false, message: "Enter the player's name." };
  const birthDate = input.birthDate?.trim() ?? "";
  try {
    const response = await post(`${seasonPath(teamId, seasonId)}/participants`, {
      displayName,
      ...(birthDate === "" ? {} : { birthDate }),
    });
    if (response.status === 201) return { ok: true, message: `Added ${displayName}.` };
    return refusal(response.status, "Check the name and the birth date (YYYY-MM-DD).");
  } catch {
    return { ok: false, message: failed };
  }
}

export interface NewGuardian {
  readonly displayName: string;
  readonly relationship: GuardianRelationship;
}

export async function linkGuardian(
  participantId: string,
  input: NewGuardian,
  post: RosterPoster = postJson,
): Promise<ActionOutcome> {
  const displayName = input.displayName.trim();
  if (displayName === "") return { ok: false, message: "Enter the guardian's name." };
  try {
    const response = await post(
      `/api/participants/${encodeURIComponent(participantId)}/guardians`,
      {
        displayName,
        relationship: input.relationship,
      },
    );
    if (response.status === 201) return { ok: true, message: `Linked ${displayName}.` };
    if (response.status === 409) {
      return { ok: false, message: "That guardian is already linked to this child." };
    }
    return refusal(response.status, "Check the guardian's name and relationship.");
  } catch {
    return { ok: false, message: failed };
  }
}

export interface ImportGuardian {
  readonly displayName: string;
  readonly relationship: string;
}

export interface ImportRow {
  readonly displayName: string;
  readonly birthDate?: string;
  readonly guardians: readonly ImportGuardian[];
}

export type ImportVerdict = "valid" | "duplicate_in_file" | "duplicate_in_roster" | "invalid";

export interface ImportIssue {
  readonly field: string;
  readonly code: string;
}

export interface ImportPreviewRow {
  readonly line: number;
  readonly verdict: ImportVerdict;
  readonly duplicateOfLine?: number;
  readonly issues?: readonly ImportIssue[];
  readonly row?: ImportRow;
}

export interface ImportPreview {
  readonly summary: {
    readonly rows: number;
    readonly valid: number;
    readonly duplicateInFile: number;
    readonly duplicateInRoster: number;
    readonly invalid: number;
  };
  readonly rows: readonly ImportPreviewRow[];
  readonly ignoredColumns: readonly number[];
}

export interface ImportRejection {
  readonly error: string;
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  readonly expectedColumns?: readonly string[];
}

export type PreviewOutcome =
  | { readonly kind: "preview"; readonly preview: ImportPreview }
  | { readonly kind: "rejected"; readonly rejection: ImportRejection }
  | { readonly kind: "failed"; readonly message: string };

export async function previewRosterImport(
  teamId: string,
  seasonId: string,
  csv: string,
  post: RosterPoster = postJson,
): Promise<PreviewOutcome> {
  if (csv.trim() === "") {
    return { kind: "failed", message: "Choose a CSV file or paste the roster first." };
  }
  try {
    const response = await post(`${seasonPath(teamId, seasonId)}/roster/import/preview`, { csv });
    if (response.status === 200) {
      return { kind: "preview", preview: response.json as ImportPreview };
    }
    if (response.status === 422 && response.json !== undefined) {
      return { kind: "rejected", rejection: response.json as ImportRejection };
    }
    return { kind: "failed", message: refusal(response.status, failed).message };
  } catch {
    return { kind: "failed", message: failed };
  }
}

export function committableRows(preview: ImportPreview): ImportRow[] {
  return preview.rows.flatMap((row) =>
    row.verdict === "valid" && row.row !== undefined ? [row.row] : [],
  );
}

export interface CommitSummary {
  readonly requested: number;
  readonly created: number;
  readonly skipped: number;
}

export async function commitRosterImport(
  teamId: string,
  seasonId: string,
  rows: readonly ImportRow[],
  post: RosterPoster = postJson,
): Promise<ActionOutcome> {
  if (rows.length === 0) return { ok: false, message: "No rows are ready to import." };
  try {
    const response = await post(`${seasonPath(teamId, seasonId)}/roster/import`, { rows });
    if (response.status === 201 || response.status === 200) {
      const { summary } = response.json as { summary: CommitSummary };
      const added = summary.created === 1 ? "1 player" : `${summary.created} players`;
      const skipped =
        summary.skipped === 0 ? "" : ` Skipped ${summary.skipped} already on the roster.`;
      return { ok: true, message: `Imported ${added}.${skipped}` };
    }
    return refusal(response.status, "Some rows changed. Preview the file again.");
  } catch {
    return { ok: false, message: failed };
  }
}

export function verdictLabel(row: ImportPreviewRow): string {
  if (row.verdict === "valid") return "Ready";
  if (row.verdict === "duplicate_in_roster") return "Already on the roster";
  if (row.verdict === "duplicate_in_file") {
    return row.duplicateOfLine === undefined
      ? "Duplicate in this file"
      : `Same child as line ${row.duplicateOfLine}`;
  }
  return "Needs a fix";
}

const GUARDIAN_FIELD = /^guardians\.(\d+)\.(displayName|relationship)$/u;

export function issueLabel(issue: ImportIssue): string {
  if (issue.field === "displayName") return "The child's name is missing.";
  if (issue.field === "birthDate") return "The birth date must be YYYY-MM-DD.";
  if (issue.field === "guardians") return "This row names too many guardians.";
  const guardian = GUARDIAN_FIELD.exec(issue.field);
  if (guardian !== null) {
    const slot = Number(guardian[1]) + 1;
    if (guardian[2] === "displayName") return `Guardian ${slot} has a relationship but no name.`;
    return `Guardian ${slot} relationship must be parent, guardian, caregiver, or other.`;
  }
  return `Check ${issue.field} (${issue.code}).`;
}
