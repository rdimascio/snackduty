import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { scheduleHref } from "../../../../schedule/format";
import { resolveSeasonScope, statusForScope } from "../../../../schedule/schedule-data";
import { ScheduleFailure } from "../../../../schedule/schedule-views";
import type { ScheduleFailureState } from "../../../../schedule/schedule-views";

type ExportData = { readonly state: ScheduleFailureState; readonly backHref?: string };

const load = async (c: Context<"/app/schedule/export">): Promise<ExportData> => {
  const scope = await resolveSeasonScope(c);
  if (scope.state !== "season") {
    statusForScope(c, scope.state);
    return { state: scope.state };
  }
  const backHref = scheduleHref("/app/schedule", {
    teamId: scope.team.id,
    seasonId: scope.season.id,
  });
  const state = scope.team.canManage ? "error" : "forbidden";
  statusForScope(c, state);
  return { state, backHref };
};

function ExportRefused(data: PageProps<typeof load>): ReactNode {
  return <ScheduleFailure backHref={data.backHref} state={data.state} />;
}

const page: PageDef<"/app/schedule/export", ExportData> = {
  component: ExportRefused,
  load,
  metadata: () => ({
    title: "Export schedule — Snackday",
    description: "Download the team schedule as a CSV file.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
