import { and, eq, inList } from "@lesto/db";
import type { Db } from "@lesto/db";

import type { AppServices } from "../lib/server/app-services";
import type { ApplicationActor } from "../lib/server/coordination-contracts";
import { createDutyOperations } from "../lib/server/duties";
import { createEventOperations } from "../lib/server/events";
import { accounts, authenticatedAdult, people } from "../lib/server/identity";
import { listAccessibleTeams } from "../lib/server/team-reads";
import { adultMemberships, manageableActiveTeam, teamAccess, teams } from "../lib/server/teams";
import { sortSlotsSnacksFirst } from "./duties-model";
import type { DutiesBoardProps, DutyAdultOption, DutyOccurrenceView } from "./duties-model";

export interface DutiesSelection {
  readonly teamId?: string;
  readonly seasonId?: string;
}

export interface SeasonChoice {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}

export type DutiesPageData =
  | { readonly state: "signed-out" }
  | { readonly state: "no-team" }
  | { readonly state: "not-found" }
  | { readonly state: "no-season"; readonly teamName: string }
  | {
      readonly state: "board";
      readonly teamName: string;
      readonly seasonLabel: string;
      readonly choices: readonly SeasonChoice[];
      readonly board: DutiesBoardProps;
    };

export function dutiesHref(teamId: string, seasonId: string): string {
  return `/app/duties?team=${encodeURIComponent(teamId)}&season=${encodeURIComponent(seasonId)}`;
}

export function formatOccurrenceWhen(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(startsAt));
}

export async function assignableTeamAdults(
  db: Db,
  teamId: string,
  viewerPersonId: string,
): Promise<DutyAdultOption[]> {
  const team = await manageableActiveTeam(db, teamId, viewerPersonId);
  if (team === undefined) return [];

  const creator = await db.select().from(teams).where(eq(teams.id, team.id)).get();
  const membershipRows = await db
    .select()
    .from(adultMemberships)
    .where(and(eq(adultMemberships.teamId, team.id), eq(adultMemberships.status, "active")))
    .all();
  const candidateIds = [
    ...new Set([
      ...(creator === undefined ? [] : [creator.createdByPersonId]),
      ...membershipRows.map((membership) => membership.personId),
    ]),
  ];
  if (candidateIds.length === 0) return [];

  const personRows = await db
    .select()
    .from(people)
    .where(and(inList(people.id, candidateIds), eq(people.status, "active")))
    .all();
  const accountRows = await db
    .select()
    .from(accounts)
    .where(and(inList(accounts.personId, candidateIds), eq(accounts.status, "active")))
    .all();
  const withAccount = new Set(accountRows.map((account) => account.personId));

  const adults: DutyAdultOption[] = [];
  for (const person of personRows) {
    if (!withAccount.has(person.id)) continue;
    if ((await teamAccess(db, team.id, person.id)) === undefined) continue;
    adults.push({ personId: person.id, displayName: person.displayName });
  }
  adults.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      left.personId.localeCompare(right.personId),
  );
  return adults;
}

export async function loadDutiesPage(
  services: AppServices | undefined,
  cookie: string | undefined,
  selection: DutiesSelection,
): Promise<DutiesPageData> {
  if (services === undefined) return { state: "signed-out" };
  const identity = await authenticatedAdult(services.db, services.sessions, cookie);
  if (identity === undefined) return { state: "signed-out" };
  const actor: ApplicationActor = { accountId: identity.account.id, personId: identity.person.id };

  const accessible = await listAccessibleTeams(services.db, actor.personId);
  const entry =
    selection.teamId === undefined
      ? accessible[0]
      : accessible.find((candidate) => candidate.team.id === selection.teamId);
  if (entry === undefined) {
    return selection.teamId === undefined ? { state: "no-team" } : { state: "not-found" };
  }

  const season =
    selection.seasonId === undefined
      ? entry.seasons[0]
      : entry.seasons.find((candidate) => candidate.id === selection.seasonId);
  if (season === undefined) {
    return selection.seasonId === undefined
      ? { state: "no-season", teamName: entry.team.name }
      : { state: "not-found" };
  }

  const coordination = { db: services.db, clock: services.clock };
  const events = await createEventOperations(coordination).listSeasonEvents(actor, {
    teamId: entry.team.id,
    seasonId: season.id,
  });
  if (!events.ok) {
    if (events.status === 404) return { state: "not-found" };
    throw new Error("Season events could not be read for the duties page.");
  }

  const nowIso = new Date(services.clock()).toISOString();
  const upcoming = events.value.events
    .flatMap(({ series, occurrences }) =>
      occurrences
        .filter((occurrence) => occurrence.startsAt > nowIso)
        .map((occurrence) => ({ series, occurrence })),
    )
    .sort(
      (left, right) =>
        left.occurrence.startsAt.localeCompare(right.occurrence.startsAt) ||
        left.occurrence.id.localeCompare(right.occurrence.id),
    );

  const duties = createDutyOperations(coordination);
  const occurrences: DutyOccurrenceView[] = [];
  for (const { series, occurrence } of upcoming) {
    const listed = await duties.listDutySlots(actor, {
      teamId: entry.team.id,
      occurrenceId: occurrence.id,
    });
    if (!listed.ok) {
      if (listed.status === 404) continue;
      throw new Error("Duty slots could not be read for the duties page.");
    }
    occurrences.push({
      id: occurrence.id,
      title: series.title,
      kind: series.kind,
      whenLabel: formatOccurrenceWhen(occurrence.startsAt, series.timeZone),
      ...(series.location === undefined ? {} : { location: series.location }),
      cancelled: occurrence.status === "cancelled",
      slots: sortSlotsSnacksFirst(
        listed.value.dutySlots.map((slot) => ({
          id: slot.id,
          label: slot.label,
          ...(slot.instructions === undefined ? {} : { instructions: slot.instructions }),
          ...(slot.assignee === undefined
            ? {}
            : {
                assignee: {
                  personId: slot.assignee.personId,
                  displayName: slot.assignee.displayName,
                },
              }),
        })),
      ),
    });
  }

  const canManage = entry.capabilities.manage;
  const choices = accessible.flatMap((candidate) =>
    candidate.seasons.map((candidateSeason) => ({
      href: dutiesHref(candidate.team.id, candidateSeason.id),
      label:
        accessible.length > 1
          ? `${candidate.team.name} · ${candidateSeason.label}`
          : candidateSeason.label,
      current: candidate.team.id === entry.team.id && candidateSeason.id === season.id,
    })),
  );

  return {
    state: "board",
    teamName: entry.team.name,
    seasonLabel: season.label,
    choices: choices.length > 1 ? choices : [],
    board: {
      teamId: entry.team.id,
      viewerPersonId: actor.personId,
      canManage,
      adults: canManage
        ? await assignableTeamAdults(services.db, entry.team.id, actor.personId)
        : [],
      occurrences,
    },
  };
}
