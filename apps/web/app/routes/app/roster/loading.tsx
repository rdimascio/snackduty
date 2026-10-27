import type { ReactNode } from "react";

import { LoadingState } from "../../../components/states/loading-state";

export default function RosterLoading(): ReactNode {
  return <LoadingState label="Loading the roster" />;
}
