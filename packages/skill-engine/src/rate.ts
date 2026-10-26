import type { EventId, SkillEvent } from "./events";
import type { Rules } from "./rules";
import { buildStreakTimeline, streakMultiplier, type StreakTimeline } from "./streak";
import type { AreaId, SkillId, Taxonomy, TaxonomySkill } from "./taxonomy";

export interface SkillRating {
  readonly skill: SkillId;
  readonly rating: number;
  readonly points: number;
  readonly drills: number;
  readonly lastTrainedAt: string;
  readonly streakAtLast: number;
}

export interface AreaRating {
  readonly area: AreaId;
  readonly rating: number;
}

export interface ExplainEntry {
  readonly event: EventId;
  readonly points: number;
}

export interface Card {
  readonly skills: readonly SkillRating[];
  readonly areas: readonly AreaRating[];
  readonly overall: number;
  readonly explain: readonly ExplainEntry[];
}

export class SkillEngineError extends Error {
  override readonly name = "SkillEngineError";
}

export function ratingFromPoints(points: number, k: number, maxRating: number): number {
  return Math.min(maxRating, Math.floor(maxRating * (1 - Math.exp(-points / k))));
}

function floorMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function byOccurrence(left: SkillEvent, right: SkillEvent): number {
  const delta = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (delta !== 0) {
    return delta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

type PointEvent = Exclude<SkillEvent, { readonly type: "void" }>;

interface SkillTotals {
  points: number;
  drills: number;
  lastTrainedAt: string;
  streakAtLast: number;
}

function validate(events: readonly SkillEvent[], skills: ReadonlyMap<string, TaxonomySkill>): void {
  const players = new Set(events.map((event) => event.playerId));
  if (players.size > 1) {
    throw new SkillEngineError("Events span more than one player");
  }
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) {
      throw new SkillEngineError(`Duplicate event id: ${event.id}`);
    }
    ids.add(event.id);
    if ("skill" in event && !skills.has(event.skill)) {
      throw new SkillEngineError(`Unknown skill: ${event.skill}`);
    }
  }
}

interface Ledger {
  readonly totals: ReadonlyMap<string, SkillTotals>;
  readonly explain: readonly ExplainEntry[];
}

function basePoints(
  event: Exclude<PointEvent, { readonly type: "card_collected" }>,
  skill: TaxonomySkill,
  rules: Rules,
): number {
  if (event.type === "drill_completed") {
    return rules.tierPoints[`${skill.tier}`];
  }
  if (event.type === "module_completed") {
    return rules.moduleMultiplier * skill.tier;
  }
  return rules.eventPoints[event.type];
}

function accumulate(
  counted: readonly PointEvent[],
  skills: ReadonlyMap<string, TaxonomySkill>,
  rules: Rules,
  timeline: StreakTimeline,
): Ledger {
  const completedModules = new Set<string>();
  const totals = new Map<string, SkillTotals>();
  const explain: ExplainEntry[] = [];

  for (const event of counted) {
    if (event.type === "card_collected") {
      explain.push({ event: event.id, points: rules.eventPoints.card_collected });
      continue;
    }
    const skill = skills.get(event.skill);
    if (!skill) {
      throw new SkillEngineError(`Unknown skill: ${event.skill}`);
    }
    if (event.type === "module_completed") {
      const moduleKey = `${event.source.id}@${event.source.version}`;
      if (completedModules.has(moduleKey)) {
        explain.push({ event: event.id, points: 0 });
        continue;
      }
      completedModules.add(moduleKey);
    }
    const streak = timeline.on(event.localDate);
    const multiplier = rules.streakMultiplied.includes(event.type)
      ? streakMultiplier(streak, rules.streak)
      : 1;
    const points = basePoints(event, skill, rules) * multiplier;
    explain.push({ event: event.id, points });

    const previous = totals.get(skill.id);
    totals.set(skill.id, {
      points: (previous?.points ?? 0) + points,
      drills: (previous?.drills ?? 0) + (event.type === "drill_completed" ? 1 : 0),
      lastTrainedAt: event.occurredAt,
      streakAtLast: streak,
    });
  }

  return { totals, explain };
}

function summarize(ledger: Ledger, taxonomy: Taxonomy, rules: Rules): Card {
  const skillRatings: SkillRating[] = taxonomy.skills.flatMap((skill) => {
    const total = ledger.totals.get(skill.id);
    if (!total) {
      return [];
    }
    return [
      {
        skill: skill.id,
        rating: ratingFromPoints(total.points, rules.k[`${skill.tier}`], rules.maxRating),
        points: total.points,
        drills: total.drills,
        lastTrainedAt: total.lastTrainedAt,
        streakAtLast: total.streakAtLast,
      },
    ];
  });

  const areas: AreaRating[] = taxonomy.areas.flatMap((area) => {
    const unlocked = skillRatings.filter((rating) => rating.skill.startsWith(`${area}.`));
    return unlocked.length === 0
      ? []
      : [{ area, rating: floorMean(unlocked.map((rating) => rating.rating)) }];
  });

  return {
    skills: skillRatings,
    areas,
    overall: floorMean(areas.map((area) => area.rating)),
    explain: ledger.explain,
  };
}

export function rate(events: readonly SkillEvent[], taxonomy: Taxonomy, rules: Rules): Card {
  const skills = new Map(taxonomy.skills.map((skill) => [skill.id, skill]));
  validate(events, skills);

  const voided = new Set(events.flatMap((event) => (event.type === "void" ? [event.voids] : [])));
  const counted = events
    .filter((event): event is PointEvent => event.type !== "void" && !voided.has(event.id))
    .toSorted(byOccurrence);
  const timeline = buildStreakTimeline(
    counted.filter((event) => event.type === "drill_completed").map((event) => event.localDate),
    rules.restDay,
  );

  return summarize(accumulate(counted, skills, rules, timeline), taxonomy, rules);
}
