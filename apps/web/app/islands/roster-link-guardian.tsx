import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { LinkGuardianForm, LinkGuardianShell } from "../roster/roster-forms";
import type { LinkGuardianProps } from "../roster/roster-forms";

function RosterLinkGuardianIsland(props: LinkGuardianProps): ReactNode {
  return <LinkGuardianForm {...props} />;
}

export default defineIsland({
  component: RosterLinkGuardianIsland,
  fallback: LinkGuardianShell,
  name: "RosterLinkGuardian",
});
