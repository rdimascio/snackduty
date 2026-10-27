import type { ReactNode } from "react";

import { LoadingState } from "../../../components/states/loading-state";

export default function ScheduleLoading(): ReactNode {
  return <LoadingState label="Loading schedule" />;
}
