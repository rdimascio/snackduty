import {
  SKILL_EVENTS_CONTRACT,
  taxonomyV0,
  type Card,
  type RateOptions,
  type SkillEvent,
  type Taxonomy,
} from "./index";

export const littleLeague: RateOptions = { ruleset: "little-league" };

export const littleLeagueAreas = [
  "hitting",
  "bunting",
  "baserunning",
  "infield",
  "outfield",
  "pitching",
  "baseball-iq",
  "mental",
];

export function retag(skillId: string, rulesets: readonly string[]): Taxonomy {
  return {
    ...taxonomyV0,
    skills: taxonomyV0.skills.map((skill) =>
      skill.id === skillId ? { ...skill, rulesets: [...rulesets] } : skill,
    ),
  };
}

type DrillEvent = Extract<SkillEvent, { readonly type: "drill_completed" }>;

const date = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);

export function drill(id: number, skill: string, day: number): DrillEvent {
  return {
    contract: SKILL_EVENTS_CONTRACT,
    id: `evt_${id}`,
    playerId: "plr_test",
    type: "drill_completed",
    skill,
    source: { kind: "module", id: "cutoffs-and-relays", version: 1 },
    occurredAt: `${date(day)}T15:00:${String(id % 60).padStart(2, "0")}Z`,
    localDate: date(day),
    app: "ballplayer",
  };
}

export function sameDayDrills(skill: string, count: number, firstId = 1): SkillEvent[] {
  return Array.from({ length: count }, (_, index) => drill(firstId + index, skill, 1));
}

export function areaRating(card: Card, area: string) {
  return card.areas.find((entry) => entry.area === area)?.rating;
}
