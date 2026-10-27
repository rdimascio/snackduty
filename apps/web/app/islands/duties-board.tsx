import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { DutiesBoard, DutiesBoardShell } from "../duties/duties-board";
import type { DutiesBoardProps } from "../duties/duties-model";

function DutiesBoardIsland(props: DutiesBoardProps): ReactNode {
  return <DutiesBoard {...props} />;
}

export default defineIsland({
  component: DutiesBoardIsland,
  fallback: DutiesBoardShell,
  name: "DutiesBoard",
});
