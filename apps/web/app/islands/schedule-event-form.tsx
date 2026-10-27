import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { EventForm } from "../schedule/event-form";
import type { EventFormProps } from "../schedule/event-form";

function ScheduleEventFormIsland(props: EventFormProps): ReactNode {
  return <EventForm {...props} />;
}

export default defineIsland({
  component: ScheduleEventFormIsland,
  fallback: ScheduleEventFormIsland,
  name: "ScheduleEventForm",
});
