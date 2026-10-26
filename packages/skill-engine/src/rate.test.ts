import { describe, expect, it } from "vitest";
import {
  rate,
  ratingFromPoints,
  rulesV0,
  SKILL_EVENTS_CONTRACT,
  taxonomyV0,
  type SkillEvent,
  type Tier,
} from "./index";

const tierSkills: Record<Tier, string> = {
  1: "infield.ready-position",
  2: "baserunning.leads",
  3: "infield.cutoff-lead",
  4: "pitching.pickoffs",
};

const tiers: readonly Tier[] = [1, 2, 3, 4];

type DrillEvent = Extract<SkillEvent, { readonly type: "drill_completed" }>;

const date = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);

function drill(id: number, skill: string, day: number): DrillEvent {
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

function sameDayDrills(skill: string, count: number): SkillEvent[] {
  return Array.from({ length: count }, (_, index) => drill(index + 1, skill, 1));
}

function skillRating(events: readonly SkillEvent[], skill: string) {
  return rate(events, taxonomyV0, rulesV0).skills.find((entry) => entry.skill === skill);
}

describe("tier points", () => {
  it("pins the tier points table", () => {
    expect(rulesV0.tierPoints).toStrictEqual({ "1": 1, "2": 2, "3": 3, "4": 5 });
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 5],
  ] as const)("a tier %i drill earns %i point(s)", (tier, points) => {
    expect(skillRating([drill(1, tierSkills[tier], 1)], tierSkills[tier])?.points).toBe(points);
  });

  it("pins the module multiplier and K per tier", () => {
    expect(rulesV0.moduleMultiplier).toBe(10);
    expect(rulesV0.k).toStrictEqual({ "1": 60, "2": 150, "3": 300, "4": 600 });
    expect(rulesV0.restDay).toStrictEqual({ windowDays: 6 });
  });
});

describe("K per tier", () => {
  const drillsTo90At1x: Record<Tier, number> = { 1: 144, 2: 180, 3: 240, 4: 288 };
  const drillsTo90At2x: Record<Tier, number> = { 1: 72, 2: 90, 3: 120, 4: 144 };
  const drillsTo50At1x: Record<Tier, number> = { 1: 43, 2: 53, 3: 71, 4: 85 };

  it.each(tiers)("tier %i reaches 90 after exactly the spec drill count at 1.0x", (tier) => {
    const skill = tierSkills[tier];
    const count = drillsTo90At1x[tier];
    expect(skillRating(sameDayDrills(skill, count - 1), skill)?.rating).toBe(89);
    expect(skillRating(sameDayDrills(skill, count), skill)?.rating).toBe(90);
  });

  it.each(tiers)("tier %i matches the 2.0x and 50-rating columns", (tier) => {
    const points = rulesV0.tierPoints[`${tier}`];
    const k = rulesV0.k[`${tier}`];
    const at = (drills: number, multiplier: number) =>
      ratingFromPoints(drills * points * multiplier, k, rulesV0.maxRating);
    expect(at(drillsTo90At2x[tier] - 1, 2)).toBeLessThan(90);
    expect(at(drillsTo90At2x[tier], 2)).toBeGreaterThanOrEqual(90);
    expect(at(drillsTo50At1x[tier] - 1, 1)).toBeLessThan(50);
    expect(at(drillsTo50At1x[tier], 1)).toBeGreaterThanOrEqual(50);
  });

  it("never exceeds the 99 cap", () => {
    expect(ratingFromPoints(1_000_000, 60, rulesV0.maxRating)).toBe(99);
  });
});

describe("rate", () => {
  it("returns an empty card for no events", () => {
    expect(rate([], taxonomyV0, rulesV0)).toStrictEqual({
      skills: [],
      areas: [],
      overall: 0,
      explain: [],
    });
  });

  it("rejects duplicate event ids", () => {
    const event = drill(1, tierSkills[1], 1);
    expect(() => rate([event, event], taxonomyV0, rulesV0)).toThrowError(
      "Duplicate event id: evt_1",
    );
  });

  it("rejects events from more than one player", () => {
    const other = { ...drill(2, tierSkills[1], 1), playerId: "plr_other" };
    expect(() => rate([drill(1, tierSkills[1], 1), other], taxonomyV0, rulesV0)).toThrowError(
      "Events span more than one player",
    );
  });
});

function seededEvents(count: number): SkillEvent[] {
  const skills = taxonomyV0.skills
    .map((skill) => skill.id)
    .filter((id) => id !== "baseball-iq.history");
  let seed = 20_261_026;
  const next = (modulo: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % modulo;
  };
  const events: SkillEvent[] = [];
  let day = 1;
  for (let index = 0; index < count; index += 1) {
    day += [0, 0, 1, 1, 1, 2, 3][next(7)] ?? 0;
    const skill = skills[next(skills.length)] ?? "infield.ready-position";
    const base = drill(index + 1, skill, day);
    const kind = next(5);
    if (kind === 0) {
      events.push({
        ...base,
        type: "check_passed",
        source: { kind: "reel-episode", id: "baseball-basics/ready-position", itemId: "q1" },
      });
    } else if (kind === 1) {
      events.push({
        ...base,
        type: "module_completed",
        source: { kind: "module", id: "cutoffs-and-relays", version: next(3) + 1 },
      });
    } else {
      events.push(base);
    }
  }
  return events;
}

describe("no decay", () => {
  it("never lowers a skill rating or its points when an event is appended", () => {
    const events = seededEvents(400);
    let previous = rate([], taxonomyV0, rulesV0);
    for (let length = 1; length <= events.length; length += 1) {
      const current = rate(events.slice(0, length), taxonomyV0, rulesV0);
      for (const before of previous.skills) {
        const after = current.skills.find((entry) => entry.skill === before.skill);
        expect(after?.rating).toBeGreaterThanOrEqual(before.rating);
        expect(after?.points).toBeGreaterThanOrEqual(before.points);
      }
      previous = current;
    }
  });
});
