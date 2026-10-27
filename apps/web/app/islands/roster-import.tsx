import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { RosterImportForm, RosterImportShell } from "../roster/roster-forms";
import type { RosterImportProps } from "../roster/roster-forms";

function RosterImportIsland(props: RosterImportProps): ReactNode {
  return <RosterImportForm {...props} />;
}

export default defineIsland({
  component: RosterImportIsland,
  fallback: RosterImportShell,
  name: "RosterImport",
});
