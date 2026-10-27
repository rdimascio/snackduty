import { ensure } from "./dev-scenario-api";
import type { DevScenarioIdentity } from "./dev-scenario-api";
import { DevScenarioLessonApi } from "./dev-scenario-lessons";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SATURDAY = 6;
const SUNDAY = 0;

export type ScenarioPersona = "owner" | "parent";
export type ScenarioAttendance = "yes" | "no" | "maybe";
type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export const PRACTICE_TITLE = "Practice";
export const PRACTICE_LOCATION = "Riverside Park, Field 2";
export const GAME_DUTIES = ["Snacks", "Scorebook", "Field setup"] as const;
export const PRACTICE_DUTIES = ["Snacks"] as const;
export const FAMILY_EVENT_TITLE = "Sunday skills clinic";
export const FAMILY_EVENT_DUTY = "Snacks";

type GameDuty = (typeof GAME_DUTIES)[number];

interface ScenarioGame {
  readonly title: string;
  readonly location: string;
  readonly claims: Readonly<Partial<Record<GameDuty, ScenarioPersona>>>;
  readonly cancelledReason?: string;
}

export const SCENARIO_GAMES: readonly ScenarioGame[] = [
  {
    title: "Game vs. Scenario Hawks (home)",
    location: "Riverside Park, Field 1",
    claims: { Snacks: "owner", Scorebook: "parent" },
  },
  {
    title: "Game at Scenario Owls (away)",
    location: "Owl Creek Fields, Diamond 3",
    claims: { Snacks: "parent", "Field setup": "owner" },
  },
  {
    title: "Game vs. Scenario Rays (home)",
    location: "Riverside Park, Field 1",
    claims: {},
    cancelledReason: "Field closed after heavy rain",
  },
  {
    title: "Game at Scenario Bears (away)",
    location: "Bear Valley Park, Field A",
    claims: {},
  },
];

export const PRACTICE_SNACK_CLAIMS: readonly ScenarioPersona[] = ["parent", "owner"];

export const SCENARIO_RSVPS = {
  parentChild: ["yes", "no"],
  ownerChild: ["no", "yes"],
} as const satisfies Record<string, readonly ScenarioAttendance[]>;

export interface ScenarioEventInput {
  readonly title: string;
  readonly kind: "practice" | "game" | "other";
  readonly location: string;
  readonly schedule: {
    readonly timeZone: string;
    readonly localTime: string;
    readonly durationMinutes: number;
    readonly frequency: "once" | "weekly";
    readonly byWeekday?: readonly Weekday[];
    readonly startDate: string;
    readonly untilDate?: string;
  };
  readonly snackDuty?: { readonly label: string };
}

export interface ScenarioSeasonWindow {
  readonly startDate: string;
  readonly endDate: string;
  readonly timeZone: string;
}

export interface ScenarioEventPlan {
  readonly practice: ScenarioEventInput;
  readonly games: readonly (ScenarioGame & { readonly input: ScenarioEventInput })[];
  readonly familyEvent: ScenarioEventInput;
}

function localDateIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
}

export function upcomingWeekdays(today: string, weekday: number, count: number): string[] {
  const first = addDays(today, ((weekday - weekdayOf(today) + 6) % 7) + 1);
  return Array.from({ length: count }, (_, index) => addDays(first, index * 7));
}

export function scenarioEventPlan(nowMs: number, season: ScenarioSeasonWindow): ScenarioEventPlan {
  const today = localDateIn(nowMs, season.timeZone);
  const saturdays = upcomingWeekdays(today, SATURDAY, SCENARIO_GAMES.length);
  const [nextSunday = addDays(today, 7)] = upcomingWeekdays(today, SUNDAY, 1);
  return {
    practice: {
      title: PRACTICE_TITLE,
      kind: "practice",
      location: PRACTICE_LOCATION,
      schedule: {
        timeZone: season.timeZone,
        localTime: "17:30",
        durationMinutes: 75,
        frequency: "weekly",
        byWeekday: ["tuesday", "thursday"],
        startDate: season.startDate,
        untilDate: season.endDate,
      },
    },
    games: SCENARIO_GAMES.map((game, index) => ({
      ...game,
      input: {
        title: game.title,
        kind: "game",
        location: game.location,
        schedule: {
          timeZone: season.timeZone,
          localTime: "09:00",
          durationMinutes: 90,
          frequency: "once",
          startDate: saturdays[index] ?? addDays(today, 7 * (index + 1)),
        },
      },
    })),
    familyEvent: {
      title: FAMILY_EVENT_TITLE,
      kind: "practice",
      location: "Lincoln Park, Diamond 1",
      schedule: {
        timeZone: season.timeZone,
        localTime: "10:00",
        durationMinutes: 60,
        frequency: "once",
        startDate: nextSunday,
      },
      snackDuty: { label: FAMILY_EVENT_DUTY },
    },
  };
}

export interface ScenarioOccurrence {
  readonly id: string;
  readonly localDate: string;
  readonly startsAt: string;
  readonly status: "scheduled" | "cancelled";
  readonly cancelledReason?: string;
  readonly attendance: { readonly yes: number; readonly no: number; readonly maybe: number };
}

export interface ScenarioSeries {
  readonly series: { readonly id: string; readonly title: string; readonly kind: string };
  readonly occurrences: readonly ScenarioOccurrence[];
}

export interface ScenarioDutySlot {
  readonly id: string;
  readonly label: string;
  readonly assignee?: { readonly personId: string; readonly displayName: string };
}

export interface ScenarioRosterEntry {
  readonly participantId?: string;
  readonly displayName?: string;
  readonly guardians?: readonly { readonly displayName?: string }[];
}

const RATE_LIMITED = /\banswered 429\b/u;
const RATE_LIMIT_RETRIES = 10;
const RATE_LIMIT_BACKOFF_MS = 500;
export const RATE_LIMIT_REFILL_MS = 2_000;

async function retryRateLimited<T>(request: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const rateLimited = error instanceof Error && RATE_LIMITED.test(error.message);
    if (!rateLimited || attempt >= RATE_LIMIT_RETRIES) throw error;
    await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
    return retryRateLimited(request, attempt + 1);
  }
}

export class DevScenarioEventApi extends DevScenarioLessonApi {
  protected override json<T>(
    step: string,
    path: string,
    init: RequestInit,
    expectedStatus: number,
  ): Promise<T> {
    return retryRateLimited(() => super.json<T>(step, path, init, expectedStatus));
  }

  override signIn(persona: "default" | "second-adult"): Promise<DevScenarioIdentity> {
    return retryRateLimited(() => super.signIn(persona));
  }

  async readSeasonRoster(
    cookie: string,
    teamId: string,
    seasonId: string,
  ): Promise<readonly ScenarioRosterEntry[]> {
    const body = await this.json<{ roster?: readonly ScenarioRosterEntry[] }>(
      "read-roster",
      `/api/teams/${teamId}/seasons/${seasonId}/roster`,
      { headers: { Cookie: cookie } },
      200,
    );
    ensure("read-roster", Array.isArray(body.roster), "response carries no roster");
    return body.roster;
  }

  async listSeasonEvents(
    cookie: string,
    teamId: string,
    seasonId: string,
  ): Promise<readonly ScenarioSeries[]> {
    const body = await this.json<{ events?: readonly ScenarioSeries[] }>(
      "list-season-events",
      `/api/teams/${teamId}/seasons/${seasonId}/events`,
      { headers: { Cookie: cookie } },
      200,
    );
    ensure("list-season-events", Array.isArray(body.events), "response carries no events");
    return body.events;
  }

  async createEvent(
    cookie: string,
    teamId: string,
    seasonId: string,
    input: ScenarioEventInput,
  ): Promise<void> {
    await this.json(
      "create-event",
      `/api/teams/${teamId}/seasons/${seasonId}/events`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(input) },
      201,
    );
  }

  async listDutySlots(
    cookie: string,
    teamId: string,
    occurrenceId: string,
  ): Promise<readonly ScenarioDutySlot[]> {
    const body = await this.json<{ dutySlots?: readonly ScenarioDutySlot[] }>(
      "list-duty-slots",
      `/api/teams/${teamId}/occurrences/${occurrenceId}/duty-slots`,
      { headers: { Cookie: cookie } },
      200,
    );
    ensure("list-duty-slots", Array.isArray(body.dutySlots), "response carries no duty slots");
    return body.dutySlots;
  }

  async createDutySlot(
    cookie: string,
    teamId: string,
    occurrenceId: string,
    label: string,
  ): Promise<ScenarioDutySlot> {
    const body = await this.json<{ dutySlot?: ScenarioDutySlot }>(
      "create-duty-slot",
      `/api/teams/${teamId}/occurrences/${occurrenceId}/duty-slots`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify({ label }) },
      201,
    );
    ensure("create-duty-slot", body.dutySlot !== undefined, "response carries no duty slot");
    return body.dutySlot;
  }

  async claimDutySlot(
    cookie: string,
    teamId: string,
    occurrenceId: string,
    slotId: string,
  ): Promise<void> {
    await this.json(
      "claim-duty-slot",
      `/api/teams/${teamId}/occurrences/${occurrenceId}/duty-slots/${slotId}/claim`,
      { method: "POST", headers: this.mutation(cookie) },
      200,
    );
  }

  async cancelOccurrence(
    cookie: string,
    teamId: string,
    occurrenceId: string,
    reason: string,
  ): Promise<void> {
    await this.json(
      "cancel-occurrence",
      `/api/teams/${teamId}/occurrences/${occurrenceId}/cancel`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify({ reason }) },
      200,
    );
  }

  async recordAttendance(
    cookie: string,
    teamId: string,
    occurrenceId: string,
    participantId: string,
    status: ScenarioAttendance,
  ): Promise<void> {
    await this.json(
      "record-attendance",
      `/api/teams/${teamId}/occurrences/${occurrenceId}/attendance`,
      {
        method: "POST",
        headers: this.mutation(cookie),
        body: JSON.stringify({ participantId, status }),
      },
      200,
    );
  }
}

export interface ScenarioAdult {
  readonly personId: string;
  readonly cookie: string;
}

export interface ScenarioEventTarget {
  readonly teamId: string;
  readonly seasonId: string;
}

export interface ScenarioEventSeed {
  readonly api: DevScenarioEventApi;
  readonly nowMs: number;
  readonly adults: Readonly<Record<ScenarioPersona, ScenarioAdult>>;
  readonly coached: ScenarioEventTarget & { readonly season: ScenarioSeasonWindow };
  readonly family: ScenarioEventTarget & { readonly season: ScenarioSeasonWindow };
  readonly rsvps: readonly {
    readonly participantId: string;
    readonly guardian: ScenarioPersona;
    readonly statuses: readonly ScenarioAttendance[];
  }[];
  readonly familyRsvp: { readonly participantId: string; readonly guardian: ScenarioPersona };
}

async function ensureSeries(
  seed: ScenarioEventSeed,
  target: ScenarioEventTarget,
  input: ScenarioEventInput,
): Promise<ScenarioSeries> {
  const owner = seed.adults.owner.cookie;
  const find = async () =>
    (await seed.api.listSeasonEvents(owner, target.teamId, target.seasonId)).find(
      (entry) => entry.series.title === input.title,
    );
  const existing = await find();
  if (existing !== undefined) return existing;
  await seed.api.createEvent(owner, target.teamId, target.seasonId, input);
  const created = await find();
  ensure("seed-events", created !== undefined, `${input.title} was not listed after creation`);
  return created;
}

function acceptsDuties(occurrence: ScenarioOccurrence, nowMs: number): boolean {
  return occurrence.status === "scheduled" && Date.parse(occurrence.startsAt) > nowMs;
}

async function ensureDuties(
  seed: ScenarioEventSeed,
  teamId: string,
  occurrence: ScenarioOccurrence,
  claims: Readonly<Partial<Record<string, ScenarioPersona>>>,
  labels: readonly string[],
): Promise<void> {
  if (!acceptsDuties(occurrence, seed.nowMs)) return;
  const owner = seed.adults.owner.cookie;
  const existing = await seed.api.listDutySlots(owner, teamId, occurrence.id);
  for (const label of labels) {
    const slot =
      existing.find((candidate) => candidate.label === label) ??
      (await seed.api.createDutySlot(owner, teamId, occurrence.id, label));
    const claimant = claims[label];
    if (claimant === undefined || slot.assignee !== undefined) continue;
    await seed.api.claimDutySlot(seed.adults[claimant].cookie, teamId, occurrence.id, slot.id);
  }
}

function upcomingScheduled(
  series: readonly ScenarioSeries[],
  nowMs: number,
): readonly ScenarioOccurrence[] {
  return series
    .flatMap((entry) => entry.occurrences)
    .filter((occurrence) => acceptsDuties(occurrence, nowMs))
    .toSorted((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export interface ScenarioEventSummary {
  readonly practices: number;
  readonly games: number;
  readonly cancelledGames: number;
}

export async function seedScenarioEvents(seed: ScenarioEventSeed): Promise<ScenarioEventSummary> {
  const { api, coached, family, adults } = seed;
  const plan = scenarioEventPlan(seed.nowMs, coached.season);

  const practice = await ensureSeries(seed, coached, plan.practice);
  const upcomingPractices = practice.occurrences.filter((occurrence) =>
    acceptsDuties(occurrence, seed.nowMs),
  );
  for (const [index, occurrence] of upcomingPractices.entries()) {
    const claimant = PRACTICE_SNACK_CLAIMS[index];
    await ensureDuties(
      seed,
      coached.teamId,
      occurrence,
      claimant === undefined ? {} : { Snacks: claimant },
      PRACTICE_DUTIES,
    );
  }

  const games: ScenarioSeries[] = [];
  for (const game of plan.games) {
    const series = await ensureSeries(seed, coached, game.input);
    games.push(series);
    const [occurrence] = series.occurrences;
    ensure("seed-events", occurrence !== undefined, `${game.title} has no occurrence`);
    await ensureDuties(seed, coached.teamId, occurrence, game.claims, GAME_DUTIES);
    if (game.cancelledReason !== undefined && occurrence.status === "scheduled") {
      await api.cancelOccurrence(
        adults.owner.cookie,
        coached.teamId,
        occurrence.id,
        game.cancelledReason,
      );
    }
  }

  const coachedEvents = await api.listSeasonEvents(
    adults.owner.cookie,
    coached.teamId,
    coached.seasonId,
  );
  const nextEvents = upcomingScheduled(coachedEvents, seed.nowMs).slice(0, 2);
  for (const rsvp of seed.rsvps) {
    for (const [index, occurrence] of nextEvents.entries()) {
      const status = rsvp.statuses[index];
      if (status === undefined) continue;
      await api.recordAttendance(
        adults[rsvp.guardian].cookie,
        coached.teamId,
        occurrence.id,
        rsvp.participantId,
        status,
      );
    }
  }

  const familyEvent = await ensureSeries(seed, family, plan.familyEvent);
  const [familyOccurrence] = familyEvent.occurrences;
  ensure("seed-events", familyOccurrence !== undefined, "the family event has no occurrence");
  if (acceptsDuties(familyOccurrence, seed.nowMs)) {
    await api.recordAttendance(
      adults[seed.familyRsvp.guardian].cookie,
      family.teamId,
      familyOccurrence.id,
      seed.familyRsvp.participantId,
      "yes",
    );
  }

  return {
    practices: practice.occurrences.length,
    games: games.length,
    cancelledGames: plan.games.filter((game) => game.cancelledReason !== undefined).length,
  };
}

export interface ScenarioEventCounts {
  readonly series: number;
  readonly occurrences: number;
  readonly cancelled: number;
  readonly dutySlots: number;
  readonly claimedSlots: number;
  readonly assignees: readonly string[];
  readonly rsvps: number;
}

export async function countScenarioEvents(
  api: DevScenarioEventApi,
  cookie: string,
  target: ScenarioEventTarget,
): Promise<ScenarioEventCounts> {
  const events = await api.listSeasonEvents(cookie, target.teamId, target.seasonId);
  const occurrences = events.flatMap((entry) => entry.occurrences);
  const slots: ScenarioDutySlot[] = [];
  for (const occurrence of occurrences) {
    slots.push(...(await api.listDutySlots(cookie, target.teamId, occurrence.id)));
  }
  const claimed = slots.flatMap((slot) => (slot.assignee === undefined ? [] : [slot.assignee]));
  return {
    series: events.length,
    occurrences: occurrences.length,
    cancelled: occurrences.filter((occurrence) => occurrence.status === "cancelled").length,
    dutySlots: slots.length,
    claimedSlots: claimed.length,
    assignees: [...new Set(claimed.map((assignee) => assignee.personId))].toSorted(),
    rsvps: occurrences.reduce(
      (total, occurrence) =>
        total + occurrence.attendance.yes + occurrence.attendance.no + occurrence.attendance.maybe,
      0,
    ),
  };
}

export async function verifyScenarioEvents(
  api: DevScenarioEventApi,
  adults: Readonly<Record<ScenarioPersona, ScenarioAdult>>,
  coached: ScenarioEventTarget,
  family: ScenarioEventTarget,
): Promise<void> {
  const step = "verify-events";
  const coachedEvents = await api.listSeasonEvents(
    adults.parent.cookie,
    coached.teamId,
    coached.seasonId,
  );
  const titles = new Set(coachedEvents.map((entry) => entry.series.title));
  ensure(
    step,
    [PRACTICE_TITLE, ...SCENARIO_GAMES.map((game) => game.title)].every((title) =>
      titles.has(title),
    ),
    "the coached season is missing its practice series or a game",
  );
  ensure(
    step,
    coachedEvents.length === SCENARIO_GAMES.length + 1,
    `the coached season holds ${coachedEvents.length} series; expected ${SCENARIO_GAMES.length + 1}`,
  );
  const cancelled = coachedEvents
    .flatMap((entry) => entry.occurrences)
    .filter((occurrence) => occurrence.status === "cancelled");
  ensure(
    step,
    cancelled.length === 1 && cancelled[0]?.cancelledReason !== undefined,
    "exactly one coached game must be cancelled with a reason",
  );
  const counts = await countScenarioEvents(api, adults.parent.cookie, coached);
  ensure(step, counts.rsvps >= 4, `the next two events carry ${counts.rsvps} RSVPs`);
  ensure(
    step,
    counts.claimedSlots > 0 && counts.claimedSlots < counts.dutySlots,
    "the coached season needs both open and claimed duty slots",
  );
  ensure(
    step,
    counts.assignees.includes(adults.owner.personId) &&
      counts.assignees.includes(adults.parent.personId),
    "both adults must hold a claimed duty slot",
  );
  const familyEvents = await api.listSeasonEvents(
    adults.parent.cookie,
    family.teamId,
    family.seasonId,
  );
  const familyOccurrence = familyEvents[0]?.occurrences[0];
  ensure(step, familyOccurrence !== undefined, "the family season has no event");
  const familySlots = await api.listDutySlots(
    adults.parent.cookie,
    family.teamId,
    familyOccurrence.id,
  );
  ensure(
    step,
    familySlots.some((slot) => slot.label === FAMILY_EVENT_DUTY && slot.assignee === undefined),
    "the family event has no open Snacks slot",
  );
  await Bun.sleep(RATE_LIMIT_REFILL_MS);
}
