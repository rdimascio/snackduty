import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { ButtonLink } from "../../../../../components/ui/button";
import ScheduleAttendanceIsland from "../../../../../islands/schedule-attendance";
import ScheduleCancelIsland from "../../../../../islands/schedule-cancel";
import { dayLabel, repeatSummary, scheduleHref } from "../../../../../schedule/format";
import {
  loadOccurrenceDetail,
  queryValue,
  resolveTeamScope,
  statusForScope,
} from "../../../../../schedule/schedule-data";
import type { OccurrenceDetail } from "../../../../../schedule/schedule-data";
import {
  CancelledBadge,
  DutyStatus,
  KindBadge,
  ScheduleFailure,
} from "../../../../../schedule/schedule-views";

type Path = "/app/schedule/events/:occurrenceId";

type DetailData =
  | { readonly state: "signed-out" | "no-team" | "not-found" | "error"; readonly backHref?: string }
  | ({
      readonly state: "ready";
      readonly teamId: string;
      readonly teamName: string;
      readonly canManage: boolean;
    } & OccurrenceDetail);

const load = async (c: Context<Path>): Promise<DetailData> => {
  const scope = await resolveTeamScope(c, queryValue(c, "team"));
  statusForScope(c, scope.state);
  if (scope.state !== "team") return { state: scope.state };

  const backHref = scheduleHref("/app/schedule", { teamId: scope.team.id });
  const detail = await loadOccurrenceDetail(scope, c.param("occurrenceId"));
  statusForScope(c, detail.state);
  if (detail.state !== "ready") return { state: detail.state, backHref };
  return {
    ...detail,
    teamId: scope.team.id,
    teamName: scope.team.name,
    canManage: scope.team.canManage,
  };
};

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

function EventDetail(data: PageProps<typeof load>): ReactNode {
  if (data.state !== "ready")
    return <ScheduleFailure backHref={data.backHref} state={data.state} />;

  const { occurrence, series, season, teamId } = data;
  const selection = { teamId, seasonId: season.id };
  const backHref = scheduleHref("/app/schedule", selection);
  return (
    <div>
      <nav aria-label="Breadcrumb" className="text-sm">
        <a
          className="font-semibold text-primary underline-offset-4 hover:underline"
          href={backHref}
        >
          ← {data.teamName} schedule
        </a>
      </nav>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            <KindBadge kind={occurrence.kind} />
            {occurrence.cancelled ? <CancelledBadge /> : null}
          </div>
          <h1 className="mt-2 break-words text-3xl font-black tracking-tight sm:text-4xl">
            {occurrence.title}
          </h1>
          <p className="mt-2 text-muted-foreground">
            <time dateTime={occurrence.localDate}>{dayLabel(occurrence.localDate)}</time> ·{" "}
            {occurrence.timeRange}
          </p>
        </div>
        {data.canManage ? (
          <ButtonLink
            href={scheduleHref(`/app/schedule/series/${encodeURIComponent(series.id)}/edit`, {
              teamId,
            })}
            variant="secondary"
          >
            Edit series
          </ButtonLink>
        ) : null}
      </div>

      {occurrence.cancelled ? (
        <p className="mt-6 rounded-xl border border-destructive bg-card p-4 text-sm" role="note">
          <span className="font-bold text-destructive">This date is cancelled.</span>{" "}
          {occurrence.cancelledReason ?? ""}
        </p>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          <ScheduleAttendanceIsland
            attendance={data.attendance}
            canManage={data.canManage}
            cancelled={occurrence.cancelled}
            occurrenceId={occurrence.id}
            teamId={teamId}
          />
        </div>
        <aside className="space-y-6">
          <section
            aria-labelledby="event-facts-title"
            className="rounded-2xl border border-border bg-card p-5 shadow-sm"
          >
            <h2 className="text-lg font-bold" id="event-facts-title">
              Details
            </h2>
            <dl className="mt-3 space-y-3 text-sm">
              <Fact label="When">
                {dayLabel(occurrence.localDate)}, {occurrence.timeRange}
                <span className="block text-muted-foreground">{season.timeZone}</span>
              </Fact>
              {occurrence.location === undefined ? null : (
                <Fact label="Location">{occurrence.location}</Fact>
              )}
              <Fact label="Repeats">{repeatSummary(series)}</Fact>
              <Fact label="Season">{season.label}</Fact>
              {occurrence.notes === undefined ? null : (
                <Fact label="Notes">
                  <span className="whitespace-pre-line">{occurrence.notes}</span>
                </Fact>
              )}
            </dl>
            <a
              className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
              href={`/api/teams/${encodeURIComponent(teamId)}/occurrences/${encodeURIComponent(occurrence.id)}/export`}
            >
              Add to calendar (.ics)
            </a>
          </section>
          <section
            aria-labelledby="event-duty-title"
            className="rounded-2xl border border-border bg-card p-5 shadow-sm"
          >
            <h2 className="text-lg font-bold" id="event-duty-title">
              Snack duty
            </h2>
            <div className="mt-3">
              <DutyStatus
                cancelled={occurrence.cancelled}
                duties={occurrence.duties}
                dutiesHref={scheduleHref("/app/duties", selection)}
              />
            </div>
          </section>
          {data.canManage && !occurrence.cancelled ? (
            <section
              aria-labelledby="event-cancel-title"
              className="rounded-2xl border border-border bg-card p-5 shadow-sm"
            >
              <h2 className="text-lg font-bold" id="event-cancel-title">
                Cancel this date
              </h2>
              <div className="mt-3">
                <ScheduleCancelIsland
                  eventTitle={occurrence.title}
                  occurrenceId={occurrence.id}
                  teamId={teamId}
                />
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

const page: PageDef<Path, DetailData> = {
  component: EventDetail,
  load,
  metadata: (data) => ({
    title: data.state === "ready" ? `${data.occurrence.title} — Snackday` : "Event — Snackday",
    description: "Event details, RSVPs, and snack duty.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
