import type { ReactNode } from "react";

import { EmptyState } from "../components/states/empty-state";
import { ButtonLink } from "../components/ui/button";
import { countsSummary, dayLabel, kindLabel, scheduleHref } from "./format";
import type { ScheduleSelection } from "./format";
import type { DayGroup, DutyView, OccurrenceView, TeamOption } from "./schedule-data";

export type ScheduleFailureState =
  | "signed-out"
  | "no-team"
  | "not-found"
  | "forbidden"
  | "no-season"
  | "error";

const FAILURE_COPY: Record<
  ScheduleFailureState,
  { readonly title: string; readonly description: string }
> = {
  "signed-out": {
    title: "Signed out",
    description:
      "Team schedules are private to the team's signed-in adults. Sign in to see this schedule.",
  },
  "no-team": {
    title: "No team yet",
    description: "Create or join a team, and its schedule will appear here.",
  },
  "not-found": {
    title: "Schedule not found",
    description:
      "This team, season, or event does not exist, or your account cannot see it. Check the link or pick another team.",
  },
  forbidden: {
    title: "Coaches only",
    description:
      "Only the team owner and co-coaches can change the schedule. You can still see events and answer for your players.",
  },
  "no-season": {
    title: "No season yet",
    description:
      "This team has no active season. A coach adds a season, then its events appear here.",
  },
  error: {
    title: "Schedule unavailable",
    description: "Snackday could not load this schedule right now. Refresh the page to try again.",
  },
};

export function ScheduleIntro({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede?: string | undefined;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-bold text-primary">{eyebrow}</p>
        <h1 className="mt-1 break-words text-3xl font-black tracking-tight sm:text-4xl">{title}</h1>
        {lede === undefined ? null : <p className="mt-2 text-muted-foreground">{lede}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ScheduleFailure({
  state,
  backHref,
}: {
  state: ScheduleFailureState;
  backHref?: string | undefined;
}): ReactNode {
  const copy = FAILURE_COPY[state];
  return (
    <div>
      <ScheduleIntro eyebrow="Schedule" title="Team schedule" />
      <div className="mt-8">
        <EmptyState
          action={
            backHref === undefined ? undefined : (
              <ButtonLink href={backHref} variant="secondary">
                Back to the schedule
              </ButtonLink>
            )
          }
          description={copy.description}
          title={copy.title}
        />
      </div>
    </div>
  );
}

export function ScopePicker({
  teams,
  current,
}: {
  teams: readonly TeamOption[];
  current: ScheduleSelection;
}): ReactNode {
  const options = teams.flatMap((team) => team.seasons.map((season) => ({ team, season })));
  if (options.length <= 1) return null;
  return (
    <details className="mt-6 rounded-xl border border-border bg-card p-3">
      <summary className="cursor-pointer text-sm font-semibold">Change team or season</summary>
      <ul aria-label="Teams and seasons" className="mt-3 grid gap-1 sm:grid-cols-2">
        {options.map(({ team, season }) => {
          const selected = team.id === current.teamId && season.id === current.seasonId;
          return (
            <li key={`${team.id}:${season.id}`}>
              <a
                aria-current={selected ? "page" : undefined}
                className="block rounded-lg px-3 py-2 text-sm hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:font-semibold"
                href={scheduleHref("/app/schedule", { teamId: team.id, seasonId: season.id })}
              >
                {team.name} · {season.label}
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function KindBadge({ kind }: { kind: string }): ReactNode {
  return (
    <span className="inline-flex rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
      {kindLabel(kind)}
    </span>
  );
}

export function CancelledBadge(): ReactNode {
  return (
    <span className="inline-flex rounded-full border border-destructive px-2.5 py-0.5 text-xs font-bold text-destructive">
      Cancelled
    </span>
  );
}

export function DutyStatus({
  duties,
  dutiesHref,
  cancelled,
}: {
  duties: readonly DutyView[];
  dutiesHref: string;
  cancelled: boolean;
}): ReactNode {
  if (duties.length === 0) {
    return <p className="text-sm text-muted-foreground">No snack duty for this event.</p>;
  }
  return (
    <ul aria-label="Snack duty" className="space-y-1">
      {duties.map((duty) => (
        <li className="text-sm" key={duty.id}>
          <span className="font-semibold">{duty.label}:</span>{" "}
          {duty.status === "mine" ? (
            <span className="font-semibold text-primary">you are bringing it</span>
          ) : duty.status === "taken" ? (
            <span className="text-muted-foreground">
              claimed by{" "}
              {duty.assigneeName === undefined || duty.assigneeName === ""
                ? "another adult"
                : duty.assigneeName}
            </span>
          ) : cancelled ? (
            <span className="text-muted-foreground">open (event cancelled)</span>
          ) : (
            <span>
              open ·{" "}
              <a
                className="font-semibold text-primary underline-offset-4 hover:underline"
                href={dutiesHref}
              >
                claim it on Duties
              </a>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function OccurrenceCard({
  occurrence,
  selection,
}: {
  occurrence: OccurrenceView;
  selection: ScheduleSelection;
}): ReactNode {
  const detailHref = scheduleHref(`/app/schedule/events/${encodeURIComponent(occurrence.id)}`, {
    teamId: selection.teamId,
  });
  return (
    <li className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted-foreground">{occurrence.timeRange}</p>
          <h3 className="mt-0.5 break-words text-lg font-bold">
            <a className="hover:underline" href={detailHref}>
              {occurrence.title}
            </a>
          </h3>
          {occurrence.location === undefined ? null : (
            <p className="mt-0.5 break-words text-sm text-muted-foreground">
              {occurrence.location}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <KindBadge kind={occurrence.kind} />
          {occurrence.cancelled ? <CancelledBadge /> : null}
        </div>
      </div>
      {occurrence.cancelled && occurrence.cancelledReason !== undefined ? (
        <p className="mt-2 text-sm text-destructive">{occurrence.cancelledReason}</p>
      ) : null}
      <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
        <p className="text-sm">
          <span className="font-semibold">RSVP:</span>{" "}
          <span className="text-muted-foreground">{countsSummary(occurrence.counts)}</span>
        </p>
        <DutyStatus
          cancelled={occurrence.cancelled}
          duties={occurrence.duties}
          dutiesHref={scheduleHref("/app/duties", selection)}
        />
      </div>
      <a
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
        href={detailHref}
      >
        {occurrence.cancelled ? "View event" : "RSVP and attendance"}
        <span className="sr-only"> for {occurrence.title}</span>
      </a>
    </li>
  );
}

export function DayGroups({
  label,
  groups,
  selection,
  empty,
}: {
  label: string;
  groups: readonly DayGroup[];
  selection: ScheduleSelection;
  empty: ReactNode;
}): ReactNode {
  const headingId = `schedule-${label.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 className="text-xl font-bold" id={headingId}>
        {label}
      </h2>
      {groups.length === 0 ? (
        <div className="mt-4">{empty}</div>
      ) : (
        <ol className="mt-4 space-y-6">
          {groups.map((group) => (
            <li key={group.localDate}>
              <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                <time dateTime={group.localDate}>{dayLabel(group.localDate)}</time>
              </h3>
              <ul className="mt-2 space-y-3">
                {group.occurrences.map((occurrence) => (
                  <OccurrenceCard
                    key={occurrence.id}
                    occurrence={occurrence}
                    selection={selection}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
