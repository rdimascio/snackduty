import { ensure } from "./dev-scenario-api";
import { DevScenarioLessonApi } from "./dev-scenario-lessons";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SATURDAY = 6;
const SUNDAY = 0;
const WEEK_MS = 7 * DAY_MS;

export type ScenarioPersona = "owner" | "parent";
export type ScenarioAttendance = "yes" | "no" | "maybe";
type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export const PRACTICE_TITLE = "Practice";
export const PRACTICE_LOCATION = "Riverside Park, Field 2";
export const GAME_SNACK_DUTY = "Snacks";
export const GAME_DUTIES = [GAME_SNACK_DUTY, "Scorebook", "Field setup"] as const;
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

export const SEEDED_DUTY_WINDOW_MS = (SCENARIO_GAMES.length + 1) * WEEK_MS;
const VERIFY_DUTY_WINDOW_MS = WEEK_MS + DAY_MS;
export const PRACTICE_SNACK_SLOTS = 3;
export const PRACTICE_SNACK_CLAIMS: readonly ScenarioPersona[] = ["parent", "owner"];
export const RSVP_EVENTS = 2;

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
        ...(game.cancelledReason === undefined ? { snackDuty: { label: GAME_SNACK_DUTY } } : {}),
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

type ScenarioOccurrenceTiming = Pick<ScenarioOccurrence, "id" | "startsAt" | "status">;

export interface ScenarioSeries {
  readonly series: { readonly id: string; readonly title: string; readonly kind: string };
  readonly occurrences: readonly ScenarioOccurrence[];
}

export interface ScenarioDutySlot {
  readonly id: string;
  readonly label: string;
  readonly assignee?: { readonly personId: string; readonly displayName: string };
}

export interface ScenarioCreatedEvent {
  readonly occurrences: readonly ScenarioOccurrenceTiming[];
  readonly dutySlots: readonly ScenarioDutySlot[];
}

export interface ScenarioRosterEntry {
  readonly participantId?: string;
  readonly displayName?: string;
  readonly guardians?: readonly { readonly displayName?: string }[];
}

export class DevScenarioEventApi extends DevScenarioLessonApi {
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
  ): Promise<ScenarioCreatedEvent> {
    const body = await this.json<Partial<ScenarioCreatedEvent>>(
      "create-event",
      `/api/teams/${teamId}/seasons/${seasonId}/events`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(input) },
      201,
    );
    ensure(
      "create-event",
      Array.isArray(body.occurrences) && Array.isArray(body.dutySlots),
      "response carries no occurrences or duty slots",
    );
    return { occurrences: body.occurrences, dutySlots: body.dutySlots };
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

function createSeries(
  seed: ScenarioEventSeed,
  target: ScenarioEventTarget,
  input: ScenarioEventInput,
): Promise<ScenarioCreatedEvent> {
  return seed.api.createEvent(seed.adults.owner.cookie, target.teamId, target.seasonId, input);
}

function acceptsDuties(occurrence: ScenarioOccurrenceTiming, nowMs: number): boolean {
  return occurrence.status === "scheduled" && Date.parse(occurrence.startsAt) > nowMs;
}

async function createDuties(
  seed: ScenarioEventSeed,
  teamId: string,
  occurrence: ScenarioOccurrenceTiming,
  claims: Readonly<Partial<Record<string, ScenarioPersona>>>,
  labels: readonly string[],
  createdWithEvent: readonly ScenarioDutySlot[] = [],
): Promise<void> {
  const owner = seed.adults.owner.cookie;
  for (const label of labels) {
    const slot =
      createdWithEvent.find((candidate) => candidate.label === label) ??
      (await seed.api.createDutySlot(owner, teamId, occurrence.id, label));
    const claimant = claims[label];
    if (claimant === undefined) continue;
    await seed.api.claimDutySlot(seed.adults[claimant].cookie, teamId, occurrence.id, slot.id);
  }
}

export function upcomingScheduled<T extends ScenarioOccurrenceTiming>(
  occurrences: readonly T[],
  nowMs: number,
): readonly T[] {
  return occurrences
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

  const practice = await createSeries(seed, coached, plan.practice);
  const snackPractices = upcomingScheduled(practice.occurrences, seed.nowMs).slice(
    0,
    PRACTICE_SNACK_SLOTS,
  );
  for (const [index, occurrence] of snackPractices.entries()) {
    const claimant = PRACTICE_SNACK_CLAIMS[index];
    await createDuties(
      seed,
      coached.teamId,
      occurrence,
      claimant === undefined ? {} : { Snacks: claimant },
      PRACTICE_DUTIES,
    );
  }

  for (const game of plan.games) {
    const created = await createSeries(seed, coached, game.input);
    const [occurrence] = created.occurrences;
    ensure("seed-events", occurrence !== undefined, `${game.title} has no occurrence`);
    if (game.cancelledReason === undefined) {
      await createDuties(
        seed,
        coached.teamId,
        occurrence,
        game.claims,
        GAME_DUTIES,
        created.dutySlots,
      );
    } else {
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
  const nextEvents = upcomingScheduled(
    coachedEvents.flatMap((entry) => entry.occurrences),
    seed.nowMs,
  ).slice(0, RSVP_EVENTS);
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

  const familyEvent = await createSeries(seed, family, plan.familyEvent);
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
    games: plan.games.length,
    cancelledGames: plan.games.filter((game) => game.cancelledReason !== undefined).length,
  };
}

export interface ScenarioDutyWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export function dutyWindow(seededAtMs: number, lengthMs: number): ScenarioDutyWindow {
  return { fromMs: seededAtMs, toMs: seededAtMs + lengthMs };
}

function inDutyWindow(occurrence: ScenarioOccurrence, window: ScenarioDutyWindow): boolean {
  const startsAtMs = Date.parse(occurrence.startsAt);
  return startsAtMs > window.fromMs && startsAtMs <= window.toMs;
}

function rsvpTotal(occurrence: ScenarioOccurrence): number {
  return occurrence.attendance.yes + occurrence.attendance.no + occurrence.attendance.maybe;
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
  window: ScenarioDutyWindow,
): Promise<ScenarioEventCounts> {
  const events = await api.listSeasonEvents(cookie, target.teamId, target.seasonId);
  const occurrences = events.flatMap((entry) => entry.occurrences);
  const slots: ScenarioDutySlot[] = [];
  for (const occurrence of occurrences.filter((candidate) => inDutyWindow(candidate, window))) {
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
    rsvps: occurrences.reduce((total, occurrence) => total + rsvpTotal(occurrence), 0),
  };
}

export async function verifyScenarioEvents(
  api: DevScenarioEventApi,
  adults: Readonly<Record<ScenarioPersona, ScenarioAdult>>,
  coached: ScenarioEventTarget,
  family: ScenarioEventTarget,
  seededAtMs: number,
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
  const coachedOccurrences = coachedEvents.flatMap((entry) => entry.occurrences);
  const rsvpTargets = upcomingScheduled(coachedOccurrences, seededAtMs)
    .slice(0, RSVP_EVENTS)
    .map((occurrence) => occurrence.id);
  const answered = coachedOccurrences
    .filter((occurrence) => rsvpTotal(occurrence) > 0)
    .map((occurrence) => occurrence.id);
  ensure(
    step,
    rsvpTargets.length === RSVP_EVENTS &&
      answered.length === RSVP_EVENTS &&
      answered.every((id) => rsvpTargets.includes(id)),
    `RSVPs sit on ${answered.join(", ")}; expected the first upcoming ${rsvpTargets.join(", ")}`,
  );
  const counts = await countScenarioEvents(
    api,
    adults.parent.cookie,
    coached,
    dutyWindow(seededAtMs, VERIFY_DUTY_WINDOW_MS),
  );
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
}
