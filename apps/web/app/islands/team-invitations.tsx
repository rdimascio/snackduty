import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { TeamInvitationsFallback, TeamInvitationsPanel } from "../team/team-invitations-panel";
import type { TeamInvitationsProps } from "../team/team-invitations-panel";

function TeamInvitations(props: TeamInvitationsProps): ReactNode {
  return <TeamInvitationsPanel {...props} />;
}

export default defineIsland({
  component: TeamInvitations,
  fallback: TeamInvitationsFallback,
  name: "TeamInvitations",
});
