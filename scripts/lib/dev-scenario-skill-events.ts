import { seedEventIdStem } from "../../apps/web/app/dev/seed-event-ids";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PAST_DAY_NOON_UTC_HOUR = 20;

export const SCENARIO_DRILL_DAYS = 7;
export const SCENARIO_MODULE = { id: "cutoffs-and-relays", version: 1 } as const;

const DRILL_ROTATION = [
  "infield.ready-position",
  "baserunning.out-of-the-box",
  "outfield.hit-the-cutoff",
  "bunting.sacrifice",
  "mental.failure",
  "hitting.approach-by-count",
  "pitching.pickoffs",
  "infield.throw-on-the-run",
  "baserunning.hook-slide",
] as const;
const DRILLS_PER_DAY = 2;

export interface ScenarioSkillEvent {
  readonly contract: "skill.events/v0";
  readonly id: string;
  readonly playerId: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly app: "snackday";
  readonly type: "drill_completed" | "module_completed" | "high_five";
  readonly skill: string;
  readonly source: {
    readonly kind: string;
    readonly id: string;
    readonly version?: number;
  };
}

export function scenarioPlayerId(participantId: string): string {
  return `plr_${participantId.replaceAll(/[^A-Za-z0-9]/gu, "")}`;
}

function localDateIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

function daysBefore(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function instantOn(localDate: string, daysAgo: number, nowMs: number, offsetMs: number): number {
  if (daysAgo === 0) return nowMs - offsetMs;
  return (
    Date.parse(`${localDate}T${String(PAST_DAY_NOON_UTC_HOUR).padStart(2, "0")}:00:00.000Z`) +
    offsetMs
  );
}

export function scenarioSkillEvents(
  participantId: string,
  nowMs: number,
  timeZone: string,
): ScenarioSkillEvent[] {
  const playerId = scenarioPlayerId(participantId);
  const idStem = seedEventIdStem(participantId);
  const today = localDateIn(nowMs, timeZone);
  const event = (
    id: string,
    instantMs: number,
    type: ScenarioSkillEvent["type"],
    skill: string,
    source: ScenarioSkillEvent["source"],
  ): ScenarioSkillEvent => ({
    contract: "skill.events/v0",
    id,
    playerId,
    occurredAt: new Date(instantMs).toISOString(),
    localDate: localDateIn(instantMs, timeZone),
    app: "snackday",
    type,
    skill,
    source,
  });

  const drills = Array.from({ length: SCENARIO_DRILL_DAYS }, (_, dayIndex) => {
    const daysAgo = SCENARIO_DRILL_DAYS - 1 - dayIndex;
    const date = daysBefore(today, daysAgo);
    return Array.from({ length: DRILLS_PER_DAY }, (_, slot) => {
      const skill =
        DRILL_ROTATION[(dayIndex * DRILLS_PER_DAY + slot) % DRILL_ROTATION.length] ??
        "infield.ready-position";
      return event(
        `${idStem}d${dayIndex}n${slot}`,
        instantOn(date, daysAgo, nowMs, (slot + 1) * 1_000),
        "drill_completed",
        skill,
        { kind: "drill", id: `scenario/${skill.replace(".", "-")}` },
      );
    });
  }).flat();

  const yesterday = daysBefore(today, 1);
  return [
    ...drills,
    event(
      `${idStem}module`,
      instantOn(yesterday, 1, nowMs, 10_000),
      "module_completed",
      "infield.cutoff-lead",
      { kind: "module", id: SCENARIO_MODULE.id, version: SCENARIO_MODULE.version },
    ),
    event(
      `${idStem}highfive`,
      instantOn(yesterday, 1, nowMs, 20_000),
      "high_five",
      "mental.failure",
      { kind: "teammate", id: "scenario/great-hustle" },
    ),
  ];
}
