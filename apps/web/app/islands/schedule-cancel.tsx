import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { CancelOccurrence } from "../schedule/cancel-occurrence";
import type { CancelOccurrenceProps } from "../schedule/cancel-occurrence";

function ScheduleCancelIsland(props: CancelOccurrenceProps): ReactNode {
  return <CancelOccurrence {...props} />;
}

export default defineIsland({
  component: ScheduleCancelIsland,
  fallback: ScheduleCancelIsland,
  name: "ScheduleCancel",
});
