import type { Db } from "@lesto/db";

import type { AppServices } from "../lib/server/app-services";
import { authorizeTeamOperation } from "../lib/server/authorization";
import { authenticatedAdult } from "../lib/server/identity";
import { listAccessibleTeams, loadRoster } from "../lib/server/team-reads";
import type { RosterEntry } from "../lib/server/team-reads";
import { mayReadParticipantCard } from "../lessons/lessons";
import { ageOn, localDateIn } from "./age";

export interface RosterSeasonChoice {
  readonly seasonId: string;
  readonly label: string;
}

export interface RosterTeamChoice {
  readonly teamId: string;
  readonly teamName: string;
  readonly seasons: readonly RosterSeasonChoice[];
}

export interface RosterGuardian {
  readonly guardianId: string;
  readonly displayName: string;
  readonly relationship: string;
}

export interface RosterInvitations {
  readonly pending: number;
  readonly expired: number;
  readonly accepted: number;
}

export interface RosterChild {
  readonly participantId: string;
  readonly displayName: string;
  readonly age?: number;
  readonly guardians: readonly RosterGuardian[];
  readonly invitations: RosterInvitations;
  readonly cardHref?: string;
}

export interface RosterSelection {
  readonly teamId?: string | undefined;
  readonly seasonId?: string | undefined;
}

interface SelectedTeam {
  readonly teams: readonly RosterTeamChoice[];
  readonly team: { readonly teamId: string; readonly teamName: string };
  readonly canManage: boolean;
}

export type RosterPageData =
  | { readonly state: "signed-out" }
  | { readonly state: "no-team" }
  | { readonly state: "not-found" }
  | (SelectedTeam & { readonly state: "no-season" })
  | (SelectedTeam & {
      readonly state: "error";
      readonly season: RosterSeasonChoice;
    })
  | (SelectedTeam & {
      readonly state: "roster";
      readonly season: RosterSeasonChoice;
      readonly children: readonly RosterChild[];
    });

export function rosterHref(teamId: string, seasonId?: string): string {
  const query = new URLSearchParams({ team: teamId });
  if (seasonId !== undefined) query.set("season", seasonId);
  return `/app/roster?${query.toString()}`;
}

export function playerCardHref(teamId: string, participantId: string, seasonId: string): string {
  const query = new URLSearchParams({ team: teamId, season: seasonId });
  return `/app/roster/${encodeURIComponent(participantId)}?${query.toString()}`;
}

async function viewerChildren(
  db: Db,
  personId: string,
  teamId: string,
  seasonId: string,
  canManage: boolean,
  entries: readonly RosterEntry[],
): Promise<RosterEntry[]> {
  if (canManage) return [...entries];
  const visible: RosterEntry[] = [];
  for (const entry of entries) {
    if (
      await authorizeTeamOperation(db, personId, "participant.read", {
        teamId,
        seasonId,
        participantId: entry.participantId,
      })
    )
      visible.push(entry);
  }
  return visible;
}

async function rosterChildren(
  services: AppServices,
  personId: string,
  target: { teamId: string; seasonId: string; timeZone: string; canManage: boolean },
  cardsEnabled: boolean,
): Promise<RosterChild[]> {
  const entries = await loadRoster(
    services.db,
    target.teamId,
    target.seasonId,
    { personId, access: target.canManage ? "manage" : "read" },
    services.clock,
  );
  const visible = await viewerChildren(
    services.db,
    personId,
    target.teamId,
    target.seasonId,
    target.canManage,
    entries,
  );
  const today = localDateIn(services.clock(), target.timeZone);
  const children: RosterChild[] = [];
  for (const entry of visible) {
    const age = entry.birthDate === undefined ? undefined : ageOn(entry.birthDate, today);
    const cardReadable =
      cardsEnabled &&
      (await mayReadParticipantCard(services.db, personId, target.teamId, entry.participantId));
    children.push({
      participantId: entry.participantId,
      displayName: entry.displayName,
      ...(age === undefined ? {} : { age }),
      guardians: entry.guardians.map(({ guardianId, displayName, relationship }) => ({
        guardianId,
        displayName,
        relationship,
      })),
      invitations: entry.guardianInvitations ?? { pending: 0, expired: 0, accepted: 0 },
      ...(cardReadable
        ? { cardHref: playerCardHref(target.teamId, entry.participantId, target.seasonId) }
        : {}),
    });
  }
  return children;
}

export async function loadRosterPage(
  services: AppServices,
  cookie: string | undefined,
  selection: RosterSelection,
  cardsEnabled: boolean,
): Promise<RosterPageData> {
  const identity = await authenticatedAdult(services.db, services.sessions, cookie);
  if (identity === undefined) return { state: "signed-out" };
  const personId = identity.person.id;

  const accessible = await listAccessibleTeams(services.db, personId);
  const picked =
    selection.teamId === undefined
      ? accessible[0]
      : accessible.find((entry) => entry.team.id === selection.teamId);
  if (picked === undefined) {
    return selection.teamId === undefined ? { state: "no-team" } : { state: "not-found" };
  }

  const teams = accessible.map((entry) => ({
    teamId: entry.team.id,
    teamName: entry.team.name,
    seasons: entry.seasons.map((season) => ({ seasonId: season.id, label: season.label })),
  }));
  const canManage = picked.capabilities.manage;
  const selected: SelectedTeam = {
    teams,
    team: { teamId: picked.team.id, teamName: picked.team.name },
    canManage,
  };

  const season =
    selection.seasonId === undefined
      ? picked.seasons[0]
      : picked.seasons.find((candidate) => candidate.id === selection.seasonId);
  if (season === undefined) {
    return selection.seasonId === undefined
      ? { ...selected, state: "no-season" }
      : { state: "not-found" };
  }
  const seasonChoice = { seasonId: season.id, label: season.label };

  try {
    const children = await rosterChildren(
      services,
      personId,
      { teamId: picked.team.id, seasonId: season.id, timeZone: season.timeZone, canManage },
      cardsEnabled,
    );
    return { ...selected, state: "roster", season: seasonChoice, children };
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "roster.page_unavailable" }));
    return { ...selected, state: "error", season: seasonChoice };
  }
}
