import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import ScheduleEventFormIsland from "../../../../islands/schedule-event-form";
import { localDateOf, scheduleHref } from "../../../../schedule/format";
import { resolveSeasonScope, statusForScope } from "../../../../schedule/schedule-data";
import type { EventFormValues } from "../../../../schedule/schedule-actions";
import { ScheduleFailure, ScheduleIntro } from "../../../../schedule/schedule-views";
import type { ScheduleFailureState } from "../../../../schedule/schedule-views";

const DAY_MS = 24 * 60 * 60 * 1_000;

type NewEventData =
  | { readonly state: ScheduleFailureState; readonly backHref?: string }
  | {
      readonly state: "ready";
      readonly selection: { readonly teamId: string; readonly seasonId: string };
      readonly teamName: string;
      readonly seasonLabel: string;
      readonly timeZone: string;
      readonly initial: EventFormValues;
    };

const load = async (c: Context<"/app/schedule/new">): Promise<NewEventData> => {
  const scope = await resolveSeasonScope(c);
  statusForScope(c, scope.state);
  if (scope.state !== "season") return { state: scope.state };
  const selection = { teamId: scope.team.id, seasonId: scope.season.id };
  if (!scope.team.canManage) {
    statusForScope(c, "forbidden");
    return { state: "forbidden", backHref: scheduleHref("/app/schedule", selection) };
  }
  const tomorrow = new Date(scope.services.clock() + DAY_MS).toISOString();
  return {
    state: "ready",
    selection,
    teamName: scope.team.name,
    seasonLabel: scope.season.label,
    timeZone: scope.season.timeZone,
    initial: {
      title: "",
      kind: "practice",
      location: "",
      notes: "",
      date: localDateOf(tomorrow, scope.season.timeZone),
      startTime: "17:00",
      endTime: "18:00",
      endsNextDay: false,
      repeat: "none",
      weekdays: [],
      untilDate: "",
      snackDuty: true,
      snackLabel: "Snacks",
      snackInstructions: "",
    },
  };
};

function NewEvent(data: PageProps<typeof load>): ReactNode {
  if (data.state !== "ready")
    return <ScheduleFailure backHref={data.backHref} state={data.state} />;
  const backHref = scheduleHref("/app/schedule", data.selection);
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
        <ScheduleIntro eyebrow="New event" lede={data.seasonLabel} title="Create an event" />
      </div>
      <div className="mt-8">
        <ScheduleEventFormIsland
          cancelHref={backHref}
          detailHrefPrefix="/app/schedule/events/"
          doneHref={backHref}
          initial={data.initial}
          mode="create"
          seasonId={data.selection.seasonId}
          teamId={data.selection.teamId}
          timeZone={data.timeZone}
        />
      </div>
    </div>
  );
}

const page: PageDef<"/app/schedule/new", NewEventData> = {
  component: NewEvent,
  load,
  metadata: () => ({
    title: "Create an event — Snackday",
    description: "Add a practice, game, or other event to the team schedule.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
