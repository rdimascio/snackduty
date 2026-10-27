import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import ScheduleEventFormIsland from "../../../../../../islands/schedule-event-form";
import { scheduleHref } from "../../../../../../schedule/format";
import {
  loadSeries,
  queryValue,
  resolveTeamScope,
  statusForScope,
} from "../../../../../../schedule/schedule-data";
import { seriesFormValues } from "../../../../../../schedule/schedule-actions";
import type { EventFormValues } from "../../../../../../schedule/schedule-actions";
import { ScheduleFailure, ScheduleIntro } from "../../../../../../schedule/schedule-views";
import type { ScheduleFailureState } from "../../../../../../schedule/schedule-views";

type Path = "/app/schedule/series/:seriesId/edit";

type EditData =
  | { readonly state: ScheduleFailureState; readonly backHref?: string }
  | {
      readonly state: "ready";
      readonly teamId: string;
      readonly seasonId: string;
      readonly seriesId: string;
      readonly teamName: string;
      readonly seriesTitle: string;
      readonly timeZone: string;
      readonly initial: EventFormValues;
    };

const load = async (c: Context<Path>): Promise<EditData> => {
  const scope = await resolveTeamScope(c, queryValue(c, "team"));
  statusForScope(c, scope.state);
  if (scope.state !== "team") return { state: scope.state };

  const backHref = scheduleHref("/app/schedule", { teamId: scope.team.id });
  const found = await loadSeries(scope, c.param("seriesId"));
  if (found === undefined) {
    statusForScope(c, "not-found");
    return { state: "not-found", backHref };
  }
  if (!scope.team.canManage) {
    statusForScope(c, "forbidden");
    return { state: "forbidden", backHref };
  }
  const { series } = found;
  return {
    state: "ready",
    teamId: scope.team.id,
    seasonId: series.seasonId,
    seriesId: series.id,
    teamName: scope.team.name,
    seriesTitle: series.title,
    timeZone: series.timeZone,
    initial: seriesFormValues(series),
  };
};

function EditSeries(data: PageProps<typeof load>): ReactNode {
  if (data.state !== "ready")
    return <ScheduleFailure backHref={data.backHref} state={data.state} />;
  const backHref = scheduleHref("/app/schedule", { teamId: data.teamId, seasonId: data.seasonId });
  return (
    <div className="max-w-3xl">
      <nav aria-label="Breadcrumb" className="text-sm">
        <a
          className="font-semibold text-primary underline-offset-4 hover:underline"
          href={backHref}
        >
          ← {data.teamName} schedule
        </a>
      </nav>
      <div className="mt-4">
        <ScheduleIntro eyebrow="Edit series" title={data.seriesTitle} />
      </div>
      <div className="mt-8">
        <ScheduleEventFormIsland
          cancelHref={backHref}
          detailHrefPrefix="/app/schedule/events/"
          doneHref={backHref}
          initial={data.initial}
          mode="edit"
          seasonId={data.seasonId}
          seriesId={data.seriesId}
          teamId={data.teamId}
          timeZone={data.timeZone}
        />
      </div>
    </div>
  );
}

const page: PageDef<Path, EditData> = {
  component: EditSeries,
  load,
  metadata: () => ({
    title: "Edit event series — Snackday",
    description: "Change an event series on the team schedule.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
