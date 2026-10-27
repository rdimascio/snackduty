import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import {
  addParticipant,
  commitRosterImport,
  committableRows,
  GUARDIAN_RELATIONSHIPS,
  issueLabel,
  linkGuardian,
  previewRosterImport,
  verdictLabel,
} from "./roster-actions";
import type {
  ActionOutcome,
  GuardianRelationship,
  ImportPreview,
  ImportRejection,
  RosterPoster,
} from "./roster-actions";

export const inputClass =
  "mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-base";
export const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold shadow-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

function reloadPage(): void {
  window.location.reload();
}

interface ActionHooks {
  readonly post?: RosterPoster;
  readonly onChanged?: () => void;
}

function OutcomeLine({ outcome }: { outcome: ActionOutcome | undefined }): ReactNode {
  if (outcome === undefined) return null;
  return outcome.ok ? (
    <p className="mt-3 text-sm font-semibold text-primary" role="status">
      {outcome.message}
    </p>
  ) : (
    <p className="mt-3 text-sm font-semibold text-destructive" role="alert">
      {outcome.message}
    </p>
  );
}

function fieldValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export type AddParticipantProps = {
  readonly teamId: string;
  readonly seasonId: string;
};

function AddParticipantFields({ disabled }: { disabled: boolean }): ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
      <label className="block text-sm font-semibold">
        Player name
        <input
          autoComplete="off"
          className={inputClass}
          disabled={disabled}
          name="displayName"
          required
          type="text"
        />
      </label>
      <label className="block text-sm font-semibold">
        Birth date <span className="font-normal text-muted-foreground">(optional)</span>
        <input className={inputClass} disabled={disabled} name="birthDate" type="date" />
      </label>
      <button
        className={`${primaryButtonClass} sm:col-span-2 sm:justify-self-start`}
        disabled={disabled}
        type="submit"
      >
        Add player
      </button>
    </div>
  );
}

export function AddParticipantShell(_props: AddParticipantProps): ReactNode {
  return (
    <form aria-label="Add a player">
      <AddParticipantFields disabled />
    </form>
  );
}

export function AddParticipantForm({
  teamId,
  seasonId,
  post,
  onChanged = reloadPage,
}: AddParticipantProps & ActionHooks): ReactNode {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    const result = await addParticipant(
      teamId,
      seasonId,
      { displayName: fieldValue(data, "displayName"), birthDate: fieldValue(data, "birthDate") },
      post,
    );
    setPending(false);
    setOutcome(result);
    if (result.ok) {
      form.reset();
      onChanged();
    }
  }

  return (
    <form aria-label="Add a player" onSubmit={(event) => void submit(event)}>
      <AddParticipantFields disabled={pending} />
      <OutcomeLine outcome={outcome} />
    </form>
  );
}

export type LinkGuardianProps = {
  readonly participantId: string;
  readonly childName: string;
};

const relationshipLabels: Readonly<Record<GuardianRelationship, string>> = {
  parent: "Parent",
  guardian: "Guardian",
  caregiver: "Caregiver",
  other: "Other",
};

function LinkGuardianFields({ disabled }: { disabled: boolean }): ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
      <label className="block text-sm font-semibold">
        Guardian name
        <input
          autoComplete="off"
          className={inputClass}
          disabled={disabled}
          name="guardianName"
          required
          type="text"
        />
      </label>
      <label className="block text-sm font-semibold">
        Relationship
        <select
          className={inputClass}
          defaultValue="parent"
          disabled={disabled}
          name="relationship"
        >
          {GUARDIAN_RELATIONSHIPS.map((relationship) => (
            <option key={relationship} value={relationship}>
              {relationshipLabels[relationship]}
            </option>
          ))}
        </select>
      </label>
      <button
        className={`${secondaryButtonClass} sm:col-span-2 sm:justify-self-start`}
        disabled={disabled}
        type="submit"
      >
        Link guardian
      </button>
    </div>
  );
}

export function LinkGuardianShell({ childName }: LinkGuardianProps): ReactNode {
  return (
    <form aria-label={`Link a guardian to ${childName}`}>
      <LinkGuardianFields disabled />
    </form>
  );
}

function isRelationship(value: string): value is GuardianRelationship {
  return (GUARDIAN_RELATIONSHIPS as readonly string[]).includes(value);
}

export function LinkGuardianForm({
  participantId,
  childName,
  post,
  onChanged = reloadPage,
}: LinkGuardianProps & ActionHooks): ReactNode {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const relationship = fieldValue(data, "relationship");
    setPending(true);
    const result = await linkGuardian(
      participantId,
      {
        displayName: fieldValue(data, "guardianName"),
        relationship: isRelationship(relationship) ? relationship : "guardian",
      },
      post,
    );
    setPending(false);
    setOutcome(result);
    if (result.ok) {
      form.reset();
      onChanged();
    }
  }

  return (
    <form aria-label={`Link a guardian to ${childName}`} onSubmit={(event) => void submit(event)}>
      <LinkGuardianFields disabled={pending} />
      <OutcomeLine outcome={outcome} />
    </form>
  );
}

export type RosterImportProps = {
  readonly teamId: string;
  readonly seasonId: string;
};

const sampleHeader = "child_name,birth_date,guardian1_name,guardian1_relationship";

function ImportFields({
  disabled,
  csv,
  onCsv,
}: {
  disabled: boolean;
  csv?: string;
  onCsv?: (csv: string) => void;
}): ReactNode {
  return (
    <div className="space-y-3">
      <label className="block text-sm font-semibold">
        CSV file
        <input
          accept=".csv,text/csv"
          className="mt-1 block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-card file:px-3 file:py-2 file:font-semibold"
          disabled={disabled}
          name="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file !== undefined && onCsv !== undefined) void file.text().then(onCsv);
          }}
          type="file"
        />
      </label>
      <label className="block text-sm font-semibold">
        Or paste the rows
        <textarea
          className={`${inputClass} min-h-28 font-mono text-sm`}
          disabled={disabled}
          name="csv"
          onChange={(event) => onCsv?.(event.currentTarget.value)}
          placeholder={sampleHeader}
          spellCheck={false}
          value={csv}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Columns: child_name, birth_date (YYYY-MM-DD, optional), guardian1_name,
        guardian1_relationship, guardian2_name, guardian2_relationship. Never include a child&apos;s
        email address.
      </p>
    </div>
  );
}

export function RosterImportShell(_props: RosterImportProps): ReactNode {
  return (
    <form aria-label="Import a roster">
      <ImportFields disabled />
      <button className={`${primaryButtonClass} mt-3`} disabled type="submit">
        Preview import
      </button>
    </form>
  );
}

function RejectionNotice({ rejection }: { rejection: ImportRejection }): ReactNode {
  const position = [
    rejection.line === undefined ? undefined : `line ${rejection.line}`,
    rejection.column === undefined ? undefined : `column ${rejection.column}`,
  ].filter((part): part is string => part !== undefined);
  return (
    <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert">
      <p className="font-semibold text-destructive">This file can&apos;t be imported.</p>
      <p className="mt-1 text-sm">{rejection.error}</p>
      {position.length === 0 ? null : (
        <p className="mt-1 text-xs text-muted-foreground">At {position.join(", ")}.</p>
      )}
      {rejection.expectedColumns === undefined ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Expected columns: {rejection.expectedColumns.join(", ")}
        </p>
      )}
    </div>
  );
}

function PreviewTable({ preview }: { preview: ImportPreview }): ReactNode {
  const { summary } = preview;
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold" role="status">
        {summary.valid} ready · {summary.duplicateInRoster} already on the roster ·{" "}
        {summary.duplicateInFile} repeated · {summary.invalid} need a fix
      </p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table aria-label="Import preview" className="w-full text-left text-sm">
          <thead className="bg-muted/60 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2" scope="col">
                Line
              </th>
              <th className="px-3 py-2" scope="col">
                Player
              </th>
              <th className="px-3 py-2" scope="col">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr className="border-t border-border align-top" key={row.line}>
                <td className="px-3 py-2 tabular-nums">{row.line}</td>
                <td className="px-3 py-2">
                  {row.row === undefined ? (
                    <span className="text-muted-foreground">Hidden until fixed</span>
                  ) : (
                    <>
                      <span className="font-semibold">{row.row.displayName}</span>
                      {row.row.guardians.length === 0 ? null : (
                        <span className="block text-xs text-muted-foreground">
                          {row.row.guardians
                            .map((guardian) => `${guardian.displayName} (${guardian.relationship})`)
                            .join(", ")}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      row.verdict === "invalid"
                        ? "font-semibold text-destructive"
                        : row.verdict === "valid"
                          ? "font-semibold text-primary"
                          : "text-muted-foreground"
                    }
                  >
                    {verdictLabel(row)}
                  </span>
                  {row.issues === undefined || row.issues.length === 0 ? null : (
                    <ul className="mt-1 list-disc pl-4 text-xs text-destructive">
                      {row.issues.map((issue) => (
                        <li key={`${issue.field}:${issue.code}`}>{issueLabel(issue)}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RosterImportForm({
  teamId,
  seasonId,
  post,
  onChanged = reloadPage,
}: RosterImportProps & ActionHooks): ReactNode {
  const [csv, setCsv] = useState("");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | undefined>();
  const [rejection, setRejection] = useState<ImportRejection | undefined>();
  const [outcome, setOutcome] = useState<ActionOutcome | undefined>();

  function changeCsv(next: string) {
    setCsv(next);
    setPreview(undefined);
    setRejection(undefined);
    setOutcome(undefined);
  }

  async function runPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setOutcome(undefined);
    const result = await previewRosterImport(teamId, seasonId, csv, post);
    setPending(false);
    if (result.kind === "preview") {
      setPreview(result.preview);
      setRejection(undefined);
    } else if (result.kind === "rejected") {
      setPreview(undefined);
      setRejection(result.rejection);
    } else {
      setPreview(undefined);
      setRejection(undefined);
      setOutcome({ ok: false, message: result.message });
    }
  }

  async function confirm() {
    if (preview === undefined) return;
    setPending(true);
    const result = await commitRosterImport(teamId, seasonId, committableRows(preview), post);
    setPending(false);
    setOutcome(result);
    if (result.ok) {
      setPreview(undefined);
      setCsv("");
      onChanged();
    }
  }

  const ready = preview === undefined ? 0 : committableRows(preview).length;

  return (
    <form aria-label="Import a roster" onSubmit={(event) => void runPreview(event)}>
      <ImportFields csv={csv} disabled={pending} onCsv={changeCsv} />
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={secondaryButtonClass} disabled={pending} type="submit">
          Preview import
        </button>
        {preview === undefined ? null : (
          <button
            className={primaryButtonClass}
            disabled={pending || ready === 0}
            onClick={() => void confirm()}
            type="button"
          >
            {ready === 1 ? "Import 1 player" : `Import ${ready} players`}
          </button>
        )}
      </div>
      {rejection === undefined ? null : <RejectionNotice rejection={rejection} />}
      {preview === undefined ? null : <PreviewTable preview={preview} />}
      <OutcomeLine outcome={outcome} />
    </form>
  );
}
