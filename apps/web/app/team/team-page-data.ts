import type { Db } from "@lesto/db";

import type { Clock } from "../lib/server/application-contracts";
import { listAccessibleTeams } from "../lib/server/team-reads";
import type { InvitationView } from "./team-actions";
import { loadCalendarFeedStatus, loadTeamInvitations, loadTeamMembers } from "./team-page-reads";
import type { MemberView } from "./team-view";

export interface SeasonView {
  readonly id: string;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly timeZone: string;
}

export interface TeamPageTeam {
  readonly state: "team";
  readonly teamId: string;
  readonly teamName: string;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly seasons: readonly SeasonView[];
  readonly season: SeasonView | undefined;
  readonly viewerPersonId: string;
  readonly viewerRole: MemberView["role"];
  readonly canManage: boolean;
  readonly canDelegate: boolean;
  readonly members: readonly MemberView[];
  readonly invitations: readonly InvitationView[] | undefined;
  readonly feedActive: boolean;
}

export type TeamPageData =
  | { readonly state: "signed-out" }
  | { readonly state: "no-team" }
  | { readonly state: "not-found" }
  | TeamPageTeam;

export interface TeamPageRequest {
  readonly teamId?: string | undefined;
  readonly seasonId?: string | undefined;
}

function seasonView(season: SeasonView): SeasonView {
  return {
    id: season.id,
    label: season.label,
    startDate: season.startDate,
    endDate: season.endDate,
    timeZone: season.timeZone,
  };
}

export async function loadTeamPage(
  db: Db,
  personId: string,
  request: TeamPageRequest,
  clock: Clock,
): Promise<TeamPageData> {
  const accessible = await listAccessibleTeams(db, personId);
  if (accessible.length === 0 && request.teamId === undefined) return { state: "no-team" };

  const selected =
    request.teamId === undefined
      ? accessible[0]
      : accessible.find((entry) => entry.team.id === request.teamId);
  if (selected === undefined) return { state: "not-found" };

  const seasons = selected.seasons.map(seasonView);
  const season =
    request.seasonId === undefined
      ? seasons[0]
      : seasons.find((candidate) => candidate.id === request.seasonId);
  if (request.seasonId !== undefined && season === undefined) return { state: "not-found" };

  const members = await loadTeamMembers(db, selected.team.id, personId);
  const feed = await loadCalendarFeedStatus(db, selected.team.id, personId);
  if (members === undefined || feed === undefined) return { state: "not-found" };
  const invitations = await loadTeamInvitations(db, selected.team.id, personId, clock);

  const viewer = members.find((member) => member.personId === personId);
  return {
    state: "team",
    teamId: selected.team.id,
    teamName: selected.team.name,
    teams: accessible.map((entry) => ({ id: entry.team.id, name: entry.team.name })),
    seasons,
    season,
    viewerPersonId: personId,
    viewerRole:
      viewer?.role ??
      (selected.capabilities.delegate ? "owner" : selected.capabilities.manage ? "coach" : "adult"),
    canManage: selected.capabilities.manage,
    canDelegate: selected.capabilities.delegate,
    members,
    invitations,
    feedActive: feed.active,
  };
}
