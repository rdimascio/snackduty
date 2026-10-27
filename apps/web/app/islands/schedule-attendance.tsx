import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { AttendancePanel } from "../schedule/attendance-panel";
import type { AttendancePanelProps } from "../schedule/attendance-panel";

function ScheduleAttendanceIsland(props: AttendancePanelProps): ReactNode {
  return <AttendancePanel {...props} />;
}

export default defineIsland({
  component: ScheduleAttendanceIsland,
  fallback: ScheduleAttendanceIsland,
  name: "ScheduleAttendance",
});
