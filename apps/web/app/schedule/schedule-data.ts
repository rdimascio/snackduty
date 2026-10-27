import type { Context } from "@lesto/web";

import { appServices } from "../lib/server/app-services";
import type { AppServices } from "../lib/server/app-services";
import { createAttendanceOperations } from "../lib/server/attendance";
import type { ApplicationActor } from "../lib/server/coordination-contracts";
import { createDutyOperations } from "../lib/server/duties";
import { createEventOperations, loadTeamEvents } from "../lib/server/events";
import { authenticatedAdult } from "../lib/server/identity";
import { listAccessibleTeams } from "../lib/server/team-reads";
import { readableActiveTeam } from "../lib/server/teams";
import { endInstant, localDateOf, timeRangeLabel } from "./format";
import type { AttendanceStatus, EventKind, Weekday } from "./format";
import type { AttendanceView } from "./schedule-actions";

export interface SeasonOption {
  readonly id: string;
  readonly label: string;
  readonly timeZone: string;
}

export interface TeamOption {
  readonly id: string;
  readonly name: string;
  readonly canManage: boolean;
  readonly seasons: readonly SeasonOption[];
}

export type ScopeFailure =
  | { readonly state: "signed-out" }
  | { readonly state: "no-team" }
  | { readonly state: "not-found" };

export interface TeamScope {
  readonly state: "team";
  readonly services: AppServices;
  readonly actor: ApplicationActor;
  readonly teams: readonly TeamOption[];
  readonly team: TeamOption;
}

export interface SeasonScope extends Omit<TeamScope, "state"> {
  readonly state: "season";
  readonly season: SeasonOption;
}

export type SeasonScopeResult =
  | ScopeFailure
  | {
      readonly state: "no-season";
      readonly team: TeamOption;
      readonly teams: readonly TeamOption[];
    }
  | SeasonScope;

export function queryValue(c: Context, name: string): string | undefined {
  const value = c.query(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export async function resolveTeamScope(
  c: Context,
  requestedTeamId: string | undefined,
): Promise<ScopeFailure | TeamScope> {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };
  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) return { state: "signed-out" };

  const accessible = await listAccessibleTeams(services.db, identity.person.id);
  const teams: TeamOption[] = accessible.map((entry) => ({
    id: entry.team.id,
    name: entry.team.name,
    canManage: entry.capabilities.manage,
    seasons: entry.seasons.map((season) => ({
      id: season.id,
      label: season.label,
      timeZone: season.timeZone,
    })),
  }));
  const team =
    requestedTeamId === undefined
      ? teams[0]
      : teams.find((candidate) => candidate.id === requestedTeamId);
  if (team === undefined) {
    return requestedTeamId === undefined ? { state: "no-team" } : { state: "not-found" };
  }
  return {
    state: "team",
    services,
    actor: { accountId: identity.account.id, personId: identity.person.id },
    teams,
    team,
  };
}

export async function resolveSeasonScope(c: Context): Promise<SeasonScopeResult> {
  const scope = await resolveTeamScope(c, queryValue(c, "team"));
  if (scope.state !== "team") return scope;
  const requestedSeasonId = queryValue(c, "season");
  const season =
    requestedSeasonId === undefined
      ? scope.team.seasons[0]
      : scope.team.seasons.find((candidate) => candidate.id === requestedSeasonId);
  if (season === undefined) {
    return requestedSeasonId === undefined
      ? { state: "no-season", team: scope.team, teams: scope.teams }
      : { state: "not-found" };
  }
  return { ...scope, state: "season", season };
}

export function statusForScope(c: Context, state: string): void {
  if (state === "signed-out") c.status(401);
  else if (state === "not-found") c.status(404);
  else if (state === "forbidden") c.status(403);
  else if (state === "error") c.status(503);
}

export interface DutyView {
  readonly id: string;
  readonly label: string;
  readonly instructions?: string;
  readonly status: "open" | "mine" | "taken";
  readonly assigneeName?: string;
}

export interface OccurrenceView {
  readonly id: string;
  readonly seriesId: string;
  readonly title: string;
  readonly kind: EventKind;
  readonly location?: string;
  readonly notes?: string;
  readonly localDate: string;
  readonly timeRange: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly cancelled: boolean;
  readonly cancelledReason?: string;
  readonly past: boolean;
  readonly counts: { readonly yes: number; readonly maybe: number; readonly no: number };
  readonly duties: readonly DutyView[];
}

export interface DayGroup {
  readonly localDate: string;
  readonly occurrences: readonly OccurrenceView[];
}

interface SeriesShape {
  readonly id: string;
  readonly title: string;
  readonly kind: EventKind;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
}

interface OccurrenceShape {
  readonly id: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly status: "scheduled" | "cancelled";
  readonly cancelledReason?: string | undefined;
  readonly attendance: { readonly yes: number; readonly maybe: number; readonly no: number };
}

async function dutiesFor(
  services: AppServices,
  actor: ApplicationActor,
  teamId: string,
  occurrenceId: string,
): Promise<DutyView[] | undefined> {
  const outcome = await createDutyOperations(services).listDutySlots(actor, {
    teamId,
    occurrenceId,
  });
  if (!outcome.ok) return undefined;
  return outcome.value.dutySlots.map((slot) => ({
    id: slot.id,
    label: slot.label,
    ...(slot.instructions === undefined ? {} : { instructions: slot.instructions }),
    status:
      slot.assignee === undefined
        ? "open"
        : slot.assignee.personId === actor.personId
          ? "mine"
          : "taken",
    ...(slot.assignee === undefined ? {} : { assigneeName: slot.assignee.displayName }),
  }));
}

function occurrenceView(
  series: SeriesShape,
  occurrence: OccurrenceShape,
  timeZone: string,
  now: string,
  duties: readonly DutyView[],
): OccurrenceView {
  return {
    id: occurrence.id,
    seriesId: series.id,
    title: series.title,
    kind: series.kind,
    ...(series.location === undefined ? {} : { location: series.location }),
    ...(series.notes === undefined ? {} : { notes: series.notes }),
    localDate: localDateOf(occurrence.startsAt, timeZone),
    timeRange: timeRangeLabel(occurrence.startsAt, occurrence.durationMinutes, timeZone),
    startsAt: occurrence.startsAt,
    durationMinutes: occurrence.durationMinutes,
    cancelled: occurrence.status === "cancelled",
    ...(occurrence.cancelledReason === undefined
      ? {}
      : { cancelledReason: occurrence.cancelledReason }),
    past: endInstant(occurrence.startsAt, occurrence.durationMinutes) <= now,
    counts: occurrence.attendance,
    duties,
  };
}

function groupByDay(occurrences: readonly OccurrenceView[]): DayGroup[] {
  const groups: { localDate: string; occurrences: OccurrenceView[] }[] = [];
  for (const occurrence of occurrences) {
    const last = groups.at(-1);
    if (last !== undefined && last.localDate === occurrence.localDate) {
      last.occurrences.push(occurrence);
    } else {
      groups.push({ localDate: occurrence.localDate, occurrences: [occurrence] });
    }
  }
  return groups;
}

export interface SeasonSchedule {
  readonly occurrences: readonly OccurrenceView[];
  readonly upcoming: readonly DayGroup[];
  readonly past: readonly DayGroup[];
}

export async function loadSeasonSchedule(scope: SeasonScope): Promise<SeasonSchedule | undefined> {
  const { services, actor, team, season } = scope;
  const outcome = await createEventOperations(services).listSeasonEvents(actor, {
    teamId: team.id,
    seasonId: season.id,
  });
  if (!outcome.ok) return undefined;

  const now = new Date(services.clock()).toISOString();
  const occurrences: OccurrenceView[] = [];
  for (const event of outcome.value.events) {
    for (const occurrence of event.occurrences) {
      const duties = await dutiesFor(services, actor, team.id, occurrence.id);
      if (duties === undefined) return undefined;
      occurrences.push(occurrenceView(event.series, occurrence, season.timeZone, now, duties));
    }
  }
  occurrences.sort(
    (left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
  );
  return {
    occurrences,
    upcoming: groupByDay(occurrences.filter((occurrence) => !occurrence.past)),
    past: groupByDay(occurrences.filter((occurrence) => occurrence.past).toReversed()),
  };
}

export interface SeriesView {
  readonly id: string;
  readonly seasonId: string;
  readonly title: string;
  readonly kind: EventKind;
  readonly location?: string;
  readonly notes?: string;
  readonly timeZone: string;
  readonly localTime: string;
  readonly durationMinutes: number;
  readonly frequency: "once" | "weekly";
  readonly byWeekday?: readonly Weekday[];
  readonly startDate: string;
  readonly untilDate?: string;
}

function teamEvents(scope: TeamScope) {
  const { services, actor, team } = scope;
  return services.db.transaction(async (tx) => {
    const readable = await readableActiveTeam(tx, team.id, actor.personId);
    if (readable === undefined) return undefined;
    return loadTeamEvents(tx, readable.id, actor.personId);
  });
}

function seriesView(series: Awaited<ReturnType<typeof loadTeamEvents>>[number]["series"]) {
  return {
    id: series.id,
    seasonId: series.seasonId,
    title: series.title,
    kind: series.kind,
    ...(series.location === undefined ? {} : { location: series.location }),
    ...(series.notes === undefined ? {} : { notes: series.notes }),
    timeZone: series.timeZone,
    localTime: series.localTime,
    durationMinutes: series.durationMinutes,
    frequency: series.frequency,
    ...(series.byWeekday === undefined ? {} : { byWeekday: series.byWeekday }),
    startDate: series.startDate,
    ...(series.untilDate === undefined ? {} : { untilDate: series.untilDate }),
  } satisfies SeriesView;
}

export async function loadSeries(scope: TeamScope, seriesId: string) {
  const events = await teamEvents(scope);
  const event = events?.find((candidate) => candidate.series.id === seriesId);
  if (event === undefined) return undefined;
  const season = scope.team.seasons.find((candidate) => candidate.id === event.series.seasonId);
  return { series: seriesView(event.series), season };
}

export interface OccurrenceDetail {
  readonly occurrence: OccurrenceView;
  readonly series: SeriesView;
  readonly season: SeasonOption;
  readonly attendance: AttendanceView;
}

export type OccurrenceDetailResult =
  | { readonly state: "not-found" }
  | { readonly state: "error" }
  | ({ readonly state: "ready" } & OccurrenceDetail);

export async function loadOccurrenceDetail(
  scope: TeamScope,
  occurrenceId: string,
): Promise<OccurrenceDetailResult> {
  const { services, actor, team } = scope;
  const events = await teamEvents(scope);
  if (events === undefined) return { state: "not-found" };
  const match = events
    .map((event) => ({
      series: event.series,
      occurrence: event.occurrences.find((candidate) => candidate.id === occurrenceId),
    }))
    .find((entry) => entry.occurrence !== undefined);
  const occurrence = match?.occurrence;
  if (match === undefined || occurrence === undefined) return { state: "not-found" };

  const season = team.seasons.find((candidate) => candidate.id === match.series.seasonId) ?? {
    id: match.series.seasonId,
    label: "This season",
    timeZone: match.series.timeZone,
  };
  const attendance = await createAttendanceOperations(services).readAttendance(actor, {
    teamId: team.id,
    occurrenceId,
  });
  const duties = await dutiesFor(services, actor, team.id, occurrenceId);
  if (!attendance.ok || duties === undefined) {
    return attendance.ok || attendance.status !== 404 ? { state: "error" } : { state: "not-found" };
  }
  const now = new Date(services.clock()).toISOString();
  return {
    state: "ready",
    occurrence: occurrenceView(match.series, occurrence, season.timeZone, now, duties),
    series: seriesView(match.series),
    season,
    attendance: {
      counts: attendance.value.attendance.counts,
      entries: attendance.value.attendance.entries.map((entry) => ({
        participantId: entry.participantId,
        displayName: entry.displayName,
        status: entry.status satisfies AttendanceStatus,
      })),
      responseOptions: attendance.value.attendance.responseOptions.map((option) => ({
        participantId: option.participantId,
        displayName: option.displayName,
        ...(option.status === undefined ? {} : { status: option.status }),
      })),
    },
  };
}
