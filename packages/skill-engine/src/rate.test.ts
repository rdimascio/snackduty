import { describe, expect, it } from "vitest";
import { rate, ratingFromPoints, rulesV0, taxonomyV0, type SkillEvent, type Tier } from "./index";
import { areaRating, drill, littleLeague, littleLeagueAreas, sameDayDrills } from "./test-events";

const tierSkills: Record<Tier, string> = {
  1: "infield.ready-position",
  2: "baserunning.leads",
  3: "infield.cutoff-lead",
  4: "pitching.pickoffs",
};

const tiers: readonly Tier[] = [1, 2, 3, 4];

function skillRating(events: readonly SkillEvent[], skill: string) {
  return rate(events, taxonomyV0, rulesV0, littleLeague).skills.find(
    (entry) => entry.skill === skill,
  );
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

  it("pins the rating scale and cap", () => {
    expect(rulesV0.ratingScale).toBe(100);
    expect(rulesV0.maxRating).toBe(99);
  });
});

describe("K per tier", () => {
  const drillsTo50At1x: Record<Tier, number> = { 1: 42, 2: 52, 3: 70, 4: 84 };
  const drillsTo90At1x: Record<Tier, number> = { 1: 139, 2: 173, 3: 231, 4: 277 };
  const drillsTo99At1x: Record<Tier, number> = { 1: 277, 2: 346, 3: 461, 4: 553 };
  const drillsTo90At2x: Record<Tier, number> = { 1: 70, 2: 87, 3: 116, 4: 139 };

  const at1x = [
    [50, drillsTo50At1x],
    [90, drillsTo90At1x],
    [99, drillsTo99At1x],
  ] as const;
  const at1xCases = at1x.flatMap(([target, table]) =>
    tiers.map((tier) => [tier, target, table[tier]] as const),
  );

  it.each(at1xCases)(
    "tier %i reaches %i after exactly %i drills at 1.0x",
    (tier, target, count) => {
      const skill = tierSkills[tier];
      expect(skillRating(sameDayDrills(skill, count - 1), skill)?.rating).toBe(target - 1);
      expect(skillRating(sameDayDrills(skill, count), skill)?.rating).toBe(target);
    },
  );

  it.each(tiers)("tier %i reaches 90 after exactly the pinned drill count at 2.0x", (tier) => {
    const points = rulesV0.tierPoints[`${tier}`];
    const k = rulesV0.k[`${tier}`];
    const at2x = (drills: number) => ratingFromPoints(drills * points * 2, k, rulesV0);
    expect(at2x(drillsTo90At2x[tier] - 1)).toBe(89);
    expect(at2x(drillsTo90At2x[tier])).toBe(90);
  });

  it.each(tiers)("tier %i reaches 99 and never exceeds it", (tier) => {
    const points = rulesV0.tierPoints[`${tier}`];
    const k = rulesV0.k[`${tier}`];
    const ratings = Array.from({ length: 5_000 }, (_, drills) =>
      ratingFromPoints(drills * points, k, rulesV0),
    );
    expect(ratings.indexOf(99)).toBe(drillsTo99At1x[tier]);
    expect(Math.max(...ratings)).toBe(99);
    expect(ratingFromPoints(1_000_000, k, rulesV0)).toBe(99);
    expect(ratingFromPoints(Number.MAX_VALUE, k, rulesV0)).toBe(99);
    const skill = tierSkills[tier];
    expect(skillRating(sameDayDrills(skill, drillsTo99At1x[tier] * 2), skill)?.rating).toBe(99);
  });
});

describe("rate", () => {
  it("returns a zero card over the Little League areas for no events", () => {
    expect(rate([], taxonomyV0, rulesV0, littleLeague)).toStrictEqual({
      skills: [],
      areas: littleLeagueAreas.map((area) => ({ area, rating: 0 })),
      overall: 0,
      explain: [],
    });
  });

  it.each(["high-school", "college", ""])(
    "rejects rule set %j that no skill carries",
    (ruleset) => {
      expect(() => rate([], taxonomyV0, rulesV0, { ruleset })).toThrowError(
        `Unknown rule set: ${ruleset}`,
      );
    },
  );

  it("rejects duplicate event ids", () => {
    const event = drill(1, tierSkills[1], 1);
    expect(() => rate([event, event], taxonomyV0, rulesV0, littleLeague)).toThrowError(
      "Duplicate event id: evt_1",
    );
  });

  it("rejects events from more than one player", () => {
    const other = { ...drill(2, tierSkills[1], 1), playerId: "plr_other" };
    expect(() =>
      rate([drill(1, tierSkills[1], 1), other], taxonomyV0, rulesV0, littleLeague),
    ).toThrowError("Events span more than one player");
  });
});

const readyPosition = sameDayDrills("infield.ready-position", 10);

describe("area ratings", () => {
  it("averages every rule-set skill in the area and counts untrained skills as 0", () => {
    const card = rate(readyPosition, taxonomyV0, rulesV0, littleLeague);
    expect(card.skills.map((entry) => [entry.skill, entry.rating])).toStrictEqual([
      ["infield.ready-position", 15],
    ]);
    expect(card.areas).toStrictEqual(
      littleLeagueAreas.map((area) => ({ area, rating: area === "infield" ? 3 : 0 })),
    );
    expect(card.overall).toBe(0);
  });

  it("does not filter by ageMin", () => {
    const events = [...readyPosition, ...sameDayDrills("infield.cutoff-lead", 4, 11)];
    const card = rate(events, taxonomyV0, rulesV0, littleLeague);
    expect(card.skills.map((entry) => [entry.skill, entry.rating])).toStrictEqual([
      ["infield.ready-position", 15],
      ["infield.cutoff-lead", 3],
    ]);
    expect(areaRating(card, "infield")).toBe(4);
    const lateSkill = {
      ...taxonomyV0,
      skills: taxonomyV0.skills.map((skill) =>
        skill.id === "infield.cutoff-lead" ? { ...skill, ageMin: 18 } : skill,
      ),
    };
    expect(areaRating(rate(events, lateSkill, rulesV0, littleLeague), "infield")).toBe(4);
  });

  it("excludes retired skills from the area mean", () => {
    const taxonomy = {
      ...taxonomyV0,
      skills: taxonomyV0.skills.map((skill) =>
        skill.id === "infield.cutoff-trail" ? { ...skill, status: "retired" as const } : skill,
      ),
    };
    expect(areaRating(rate(readyPosition, taxonomy, rulesV0, littleLeague), "infield")).toBe(5);
  });
});

describe("overall rating", () => {
  it.each(taxonomyV0.skills.map((skill) => skill.id))(
    "starting %s never lowers its area or overall",
    (skill) => {
      const before = rate(readyPosition, taxonomyV0, rulesV0, littleLeague);
      const after = rate(
        [...readyPosition, ...sameDayDrills(skill, 1, 11)],
        taxonomyV0,
        rulesV0,
        littleLeague,
      );
      expect(after.areas.map((entry) => entry.area)).toStrictEqual(
        before.areas.map((entry) => entry.area),
      );
      for (const area of before.areas) {
        expect(areaRating(after, area.area)).toBeGreaterThanOrEqual(area.rating);
      }
      expect(after.overall).toBeGreaterThanOrEqual(before.overall);
    },
  );
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
  it("never lowers a skill, area or overall rating when an event is appended", () => {
    const events = seededEvents(400);
    let previous = rate([], taxonomyV0, rulesV0, littleLeague);
    for (let length = 1; length <= events.length; length += 1) {
      const current = rate(events.slice(0, length), taxonomyV0, rulesV0, littleLeague);
      for (const before of previous.skills) {
        const after = current.skills.find((entry) => entry.skill === before.skill);
        expect(after?.rating).toBeGreaterThanOrEqual(before.rating);
        expect(after?.points).toBeGreaterThanOrEqual(before.points);
      }
      for (const before of previous.areas) {
        expect(areaRating(current, before.area)).toBeGreaterThanOrEqual(before.rating);
      }
      expect(current.overall).toBeGreaterThanOrEqual(previous.overall);
      previous = current;
    }
  });
});
