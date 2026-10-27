import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { AddParticipantForm, AddParticipantShell } from "../roster/roster-forms";
import type { AddParticipantProps } from "../roster/roster-forms";

function RosterAddParticipantIsland(props: AddParticipantProps): ReactNode {
  return <AddParticipantForm {...props} />;
}

export default defineIsland({
  component: RosterAddParticipantIsland,
  fallback: AddParticipantShell,
  name: "RosterAddParticipant",
});
