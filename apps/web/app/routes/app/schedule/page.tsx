import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { EmptyState } from "../../../components/states/empty-state";
import { ButtonLink } from "../../../components/ui/button";
import { scheduleHref } from "../../../schedule/format";
import type { ScheduleSelection } from "../../../schedule/format";
import {
  loadSeasonSchedule,
  resolveSeasonScope,
  statusForScope,
} from "../../../schedule/schedule-data";
import type { DayGroup, TeamOption } from "../../../schedule/schedule-data";
import {
  DayGroups,
  ScheduleFailure,
  ScheduleIntro,
  ScopePicker,
} from "../../../schedule/schedule-views";
import type { ScheduleFailureState } from "../../../schedule/schedule-views";

type ScheduleData =
  | { readonly state: Exclude<ScheduleFailureState, "no-season" | "forbidden"> }
  | {
      readonly state: "no-season";
      readonly teams: readonly TeamOption[];
      readonly teamName: string;
      readonly selection: ScheduleSelection;
    }
  | {
      readonly state: "ready";
      readonly teams: readonly TeamOption[];
      readonly selection: ScheduleSelection;
      readonly teamName: string;
      readonly seasonLabel: string;
      readonly timeZone: string;
      readonly canManage: boolean;
      readonly upcoming: readonly DayGroup[];
      readonly past: readonly DayGroup[];
    };

const load = async (c: Context<"/app/schedule">): Promise<ScheduleData> => {
  const scope = await resolveSeasonScope(c);
  statusForScope(c, scope.state);
  if (scope.state === "signed-out" || scope.state === "no-team" || scope.state === "not-found") {
    return { state: scope.state };
  }
  if (scope.state === "no-season") {
    return {
      state: "no-season",
      teams: scope.teams,
      teamName: scope.team.name,
      selection: { teamId: scope.team.id },
    };
  }
  const schedule = await loadSeasonSchedule(scope);
  if (schedule === undefined) {
    statusForScope(c, "error");
    return { state: "error" };
  }
  return {
    state: "ready",
    teams: scope.teams,
    selection: { teamId: scope.team.id, seasonId: scope.season.id },
    teamName: scope.team.name,
    seasonLabel: scope.season.label,
    timeZone: scope.season.timeZone,
    canManage: scope.team.canManage,
    upcoming: schedule.upcoming,
    past: schedule.past,
  };
};

function CoachActions({ selection }: { selection: ScheduleSelection }): ReactNode {
  return (
    <>
      <ButtonLink href={scheduleHref("/app/schedule/new", selection)}>Create event</ButtonLink>
      <ButtonLink
        download
        href={scheduleHref("/app/schedule/export", selection)}
        variant="secondary"
      >
        Export CSV
      </ButtonLink>
    </>
  );
}

function SchedulePage(data: PageProps<typeof load>): ReactNode {
  if (data.state === "no-season") {
    return (
      <div>
        <ScheduleIntro eyebrow="Schedule" lede="No active season" title={data.teamName} />
        <ScopePicker current={data.selection} teams={data.teams} />
        <div className="mt-8">
          <EmptyState
            description="This team has no active season. A coach adds a season, then its events appear here."
            title="No season yet"
          />
        </div>
      </div>
    );
  }
  if (data.state !== "ready") return <ScheduleFailure state={data.state} />;

  const { selection } = data;
  const nothingYet = data.upcoming.length === 0 && data.past.length === 0;
  return (
    <div>
      <ScheduleIntro
        actions={data.canManage ? <CoachActions selection={selection} /> : undefined}
        eyebrow="Schedule"
        lede={`${data.seasonLabel} · Times in ${data.timeZone}`}
        title={data.teamName}
      />
      <ScopePicker current={selection} teams={data.teams} />
      <p className="mt-4 text-sm text-muted-foreground">
        Snack duties are claimed on the{" "}
        <a
          className="font-semibold text-primary underline-offset-4 hover:underline"
          href={scheduleHref("/app/duties", selection)}
        >
          Duties page
        </a>
        .
      </p>
      {nothingYet ? (
        <div className="mt-8">
          <EmptyState
            action={
              data.canManage ? (
                <ButtonLink href={scheduleHref("/app/schedule/new", selection)}>
                  Create the first event
                </ButtonLink>
              ) : undefined
            }
            description={
              data.canManage
                ? "Create the first practice or game for this season."
                : "Events appear here after a coach adds them."
            }
            title="No events yet"
          />
        </div>
      ) : (
        <>
          <DayGroups
            empty={
              <p className="text-sm text-muted-foreground">
                Nothing else is scheduled this season.
              </p>
            }
            groups={data.upcoming}
            label="Upcoming"
            selection={selection}
          />
          <DayGroups
            empty={<p className="text-sm text-muted-foreground">No past events yet.</p>}
            groups={data.past}
            label="Past"
            selection={selection}
          />
        </>
      )}
    </div>
  );
}

const page: PageDef<"/app/schedule", ScheduleData> = {
  component: SchedulePage,
  load,
  metadata: () => ({
    title: "Schedule — Snackday",
    description: "Practices, games, RSVPs, and snack duty for your team.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
