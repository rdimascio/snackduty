import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import { fetchTransport, myDuties, openSlotCount, performDutyAction } from "./duties-model";
import type {
  DutiesBoardProps,
  DutiesTransport,
  DutyAction,
  DutyAdultOption,
  DutyOccurrenceView,
  DutySlotView,
} from "./duties-model";

interface Notice {
  readonly ok: boolean;
  readonly message: string;
  readonly stale: boolean;
}

interface BoardControls {
  readonly interactive: boolean;
  readonly pendingOccurrenceId: string | undefined;
  readonly notices: Readonly<Record<string, Notice>>;
  readonly run: (action: DutyAction) => Promise<boolean>;
  readonly reload: () => void;
}

const staticControls: BoardControls = {
  interactive: false,
  pendingOccurrenceId: undefined,
  notices: {},
  run: () => Promise.resolve(false),
  reload: () => undefined,
};

function reloadPage(): void {
  window.location.reload();
}

const primaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-card-foreground shadow-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const fieldClass =
  "mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm";

function occurrenceAnchor(occurrenceId: string): string {
  return `duty-occurrence-${occurrenceId}`;
}

function kindLabel(kind: string): string {
  if (kind === "game") return "Game";
  if (kind === "practice") return "Practice";
  return "Event";
}

function MyDutiesSection({
  occurrences,
  viewerPersonId,
}: {
  occurrences: readonly DutyOccurrenceView[];
  viewerPersonId: string;
}): ReactNode {
  const mine = myDuties(occurrences, viewerPersonId);
  return (
    <section
      aria-labelledby="my-duties-title"
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="text-xl font-bold" id="my-duties-title">
        My duties
      </h2>
      {mine.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          You hold no upcoming duties. Claim an open slot below to help the team.
        </p>
      ) : (
        <ul aria-label="My duties" className="mt-3 divide-y divide-border">
          {mine.map((duty) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
              key={duty.slotId}
            >
              <a
                className="font-semibold text-primary underline-offset-4 hover:underline"
                href={`#${occurrenceAnchor(duty.occurrenceId)}`}
              >
                {duty.label}
              </a>
              <span className="text-sm text-muted-foreground">
                {duty.title} · {duty.whenLabel}
                {duty.cancelled ? " · Cancelled" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AssignForm({
  adults,
  disabled,
  occurrenceId,
  slot,
  run,
}: {
  adults: readonly DutyAdultOption[];
  disabled: boolean;
  occurrenceId: string;
  slot: DutySlotView;
  run: BoardControls["run"];
}): ReactNode {
  const candidates = adults.filter((adult) => adult.personId !== slot.assignee?.personId);
  if (candidates.length === 0) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("assigneePersonId");
    if (typeof value !== "string" || value === "") return;
    void run({ kind: "assign", occurrenceId, slotId: slot.id, assigneePersonId: value });
  }

  return (
    <form
      aria-label={`Assign ${slot.label}`}
      className="flex flex-wrap items-end gap-2"
      onSubmit={submit}
    >
      <label className="text-xs font-semibold text-muted-foreground">
        Assign an adult
        <select className={fieldClass} disabled={disabled} name="assigneePersonId">
          {candidates.map((adult) => (
            <option key={adult.personId} value={adult.personId}>
              {adult.displayName}
            </option>
          ))}
        </select>
      </label>
      <button className={secondaryButton} disabled={disabled} type="submit">
        Assign
      </button>
    </form>
  );
}

function SlotRow({
  adults,
  canManage,
  controls,
  locked,
  occurrenceId,
  slot,
  viewerPersonId,
}: {
  adults: readonly DutyAdultOption[];
  canManage: boolean;
  controls: BoardControls;
  locked: boolean;
  occurrenceId: string;
  slot: DutySlotView;
  viewerPersonId: string;
}): ReactNode {
  const disabled = !controls.interactive || locked || controls.pendingOccurrenceId !== undefined;
  const mine = slot.assignee?.personId === viewerPersonId;
  const open = slot.assignee === undefined;

  return (
    <li
      className={
        open && !locked
          ? "rounded-xl border-2 border-dashed border-primary bg-accent/40 p-4"
          : "rounded-xl border border-border bg-background p-4"
      }
      data-slot-state={open ? "open" : mine ? "mine" : "taken"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{slot.label}</p>
          {slot.instructions === undefined ? null : (
            <p className="mt-1 text-sm text-muted-foreground">{slot.instructions}</p>
          )}
          <p className="mt-2 text-sm">
            {open ? (
              <span className="inline-flex rounded-full bg-primary px-2.5 py-0.5 text-xs font-bold text-primary-foreground">
                Open
              </span>
            ) : mine ? (
              <span className="font-semibold text-primary">Claimed by you</span>
            ) : (
              <span className="text-muted-foreground">
                {`Claimed by ${slot.assignee?.displayName || "a team adult"}`}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open ? (
            <button
              className={primaryButton}
              disabled={disabled}
              onClick={() => void controls.run({ kind: "claim", occurrenceId, slotId: slot.id })}
              type="button"
            >
              {`Claim ${slot.label}`}
            </button>
          ) : null}
          {mine ? (
            <button
              className={secondaryButton}
              disabled={disabled}
              onClick={() => void controls.run({ kind: "release", occurrenceId, slotId: slot.id })}
              type="button"
            >
              Release
            </button>
          ) : null}
          {canManage && !open && !mine ? (
            <button
              className={secondaryButton}
              disabled={disabled}
              onClick={() =>
                void controls.run({
                  kind: "assign",
                  occurrenceId,
                  slotId: slot.id,
                  assigneePersonId: null,
                })
              }
              type="button"
            >
              Unassign
            </button>
          ) : null}
        </div>
      </div>
      {canManage && !locked ? (
        <div className="mt-3 border-t border-border pt-3">
          <AssignForm
            adults={adults}
            disabled={disabled}
            occurrenceId={occurrenceId}
            run={controls.run}
            slot={slot}
          />
        </div>
      ) : null}
    </li>
  );
}

function AddSlotForm({
  controls,
  occurrenceId,
}: {
  controls: BoardControls;
  occurrenceId: string;
}): ReactNode {
  const disabled = !controls.interactive || controls.pendingOccurrenceId !== undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const label = String(data.get("label") ?? "").trim();
    const instructions = String(data.get("instructions") ?? "").trim();
    if (label === "") return;
    const saved = await controls.run({
      kind: "add",
      occurrenceId,
      label,
      ...(instructions === "" ? {} : { instructions }),
    });
    if (saved) form.reset();
  }

  return (
    <details className="mt-4 rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">Add a duty slot</summary>
      <form
        aria-label="Add a duty slot"
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
        onSubmit={(event) => void submit(event)}
      >
        <label className="text-xs font-semibold text-muted-foreground">
          Duty
          <input
            className={fieldClass}
            disabled={disabled}
            maxLength={120}
            name="label"
            placeholder="Snacks"
            required
            type="text"
          />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">
          Instructions (optional)
          <input
            className={fieldClass}
            disabled={disabled}
            maxLength={2000}
            name="instructions"
            placeholder="Enough for twelve players"
            type="text"
          />
        </label>
        <button className={primaryButton} disabled={disabled} type="submit">
          Add slot
        </button>
      </form>
    </details>
  );
}

function OccurrenceCard({
  board,
  controls,
  occurrence,
}: {
  board: DutiesBoardProps;
  controls: BoardControls;
  occurrence: DutyOccurrenceView;
}): ReactNode {
  const notice = controls.notices[occurrence.id];
  const open = occurrence.slots.filter((slot) => slot.assignee === undefined).length;
  return (
    <li
      aria-labelledby={`${occurrenceAnchor(occurrence.id)}-title`}
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
      id={occurrenceAnchor(occurrence.id)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {kindLabel(occurrence.kind)}
          </p>
          <h3 className="text-lg font-bold" id={`${occurrenceAnchor(occurrence.id)}-title`}>
            {occurrence.title}
          </h3>
          <p className="text-sm text-muted-foreground">
            {occurrence.whenLabel}
            {occurrence.location === undefined ? "" : ` · ${occurrence.location}`}
          </p>
        </div>
        {occurrence.cancelled ? (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold text-destructive">
            Cancelled
          </span>
        ) : open > 0 ? (
          <span className="rounded-full bg-accent px-3 py-1 text-xs font-bold text-accent-foreground">
            {open === 1 ? "1 open slot" : `${open} open slots`}
          </span>
        ) : occurrence.slots.length > 0 ? (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold text-muted-foreground">
            All covered
          </span>
        ) : null}
      </div>
      {occurrence.slots.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {occurrence.cancelled
            ? "This event is cancelled, so it needs no duties."
            : board.canManage
              ? "No duty slots yet. Add one below."
              : "No duties are listed for this event yet."}
        </p>
      ) : (
        <ul aria-label={`Duties for ${occurrence.title}`} className="mt-4 space-y-3">
          {occurrence.slots.map((slot) => (
            <SlotRow
              adults={board.adults}
              canManage={board.canManage}
              controls={controls}
              key={slot.id}
              locked={occurrence.cancelled}
              occurrenceId={occurrence.id}
              slot={slot}
              viewerPersonId={board.viewerPersonId}
            />
          ))}
        </ul>
      )}
      {notice === undefined ? null : (
        <p
          className={
            notice.ok
              ? "mt-3 text-sm font-semibold text-primary"
              : "mt-3 text-sm font-semibold text-destructive"
          }
          role={notice.ok ? "status" : "alert"}
        >
          {notice.message}
        </p>
      )}
      {notice?.stale === true ? (
        <button className={`${secondaryButton} mt-2`} onClick={controls.reload} type="button">
          Reload the list
        </button>
      ) : null}
      {controls.pendingOccurrenceId === occurrence.id ? (
        <p aria-live="polite" className="mt-3 text-sm text-muted-foreground" role="status">
          Saving…
        </p>
      ) : null}
      {board.canManage && !occurrence.cancelled ? (
        <AddSlotForm controls={controls} occurrenceId={occurrence.id} />
      ) : null}
    </li>
  );
}

function BoardView({
  board,
  controls,
}: {
  board: DutiesBoardProps;
  controls: BoardControls;
}): ReactNode {
  const open = openSlotCount(board.occurrences);
  return (
    <div className="space-y-8">
      <MyDutiesSection occurrences={board.occurrences} viewerPersonId={board.viewerPersonId} />
      <section aria-labelledby="upcoming-duties-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold" id="upcoming-duties-title">
            Upcoming events
          </h2>
          <p className="text-sm text-muted-foreground">
            {open === 0 ? "No open slots" : open === 1 ? "1 open slot" : `${open} open slots`}
          </p>
        </div>
        <ol className="mt-4 space-y-4">
          {board.occurrences.map((occurrence) => (
            <OccurrenceCard
              board={board}
              controls={controls}
              key={occurrence.id}
              occurrence={occurrence}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

export function DutiesBoardShell(props: DutiesBoardProps): ReactNode {
  return <BoardView board={props} controls={staticControls} />;
}

export function DutiesBoard({
  transport = fetchTransport,
  reload = reloadPage,
  ...props
}: DutiesBoardProps & {
  readonly transport?: DutiesTransport;
  readonly reload?: () => void;
}): ReactNode {
  const [occurrences, setOccurrences] = useState<readonly DutyOccurrenceView[]>(props.occurrences);
  const [pendingOccurrenceId, setPendingOccurrenceId] = useState<string | undefined>();
  const [notices, setNotices] = useState<Readonly<Record<string, Notice>>>({});

  async function run(action: DutyAction): Promise<boolean> {
    const occurrence = occurrences.find((candidate) => candidate.id === action.occurrenceId);
    if (occurrence === undefined || pendingOccurrenceId !== undefined) return false;
    setPendingOccurrenceId(action.occurrenceId);
    try {
      const result = await performDutyAction(transport, props.teamId, action, {
        slots: occurrence.slots,
        adults: props.adults,
      });
      const refreshed = result.slots;
      if (refreshed !== undefined) {
        setOccurrences((current) =>
          current.map((candidate) =>
            candidate.id === action.occurrenceId ? { ...candidate, slots: refreshed } : candidate,
          ),
        );
      }
      setNotices((current) => ({
        ...current,
        [action.occurrenceId]: {
          ok: result.ok,
          message: result.message,
          stale: result.stale === true,
        },
      }));
      return result.ok;
    } finally {
      setPendingOccurrenceId(undefined);
    }
  }

  return (
    <BoardView
      board={{ ...props, occurrences }}
      controls={{ interactive: true, pendingOccurrenceId, notices, run, reload }}
    />
  );
}
