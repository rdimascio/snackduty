import { describe, expect, it } from "vitest";
import { rate, rulesV0, taxonomyV0 } from "./index";
import { areaRating, littleLeague, littleLeagueAreas, retag, sameDayDrills } from "./test-events";

const readyPosition = sameDayDrills("infield.ready-position", 10);

describe("rule set filter", () => {
  it("keeps a skill outside the rule set in its own rating but not in the area mean", () => {
    const events = [
      ...sameDayDrills("baserunning.out-of-the-box", 10),
      ...sameDayDrills("baserunning.leads", 4, 11),
    ];
    const card = rate(events, taxonomyV0, rulesV0, littleLeague);
    expect(card.skills.map((entry) => [entry.skill, entry.rating])).toStrictEqual([
      ["baserunning.out-of-the-box", 15],
      ["baserunning.leads", 5],
    ]);
    expect(areaRating(card, "baserunning")).toBe(7);
    const tagged = retag("baserunning.leads", ["little-league"]);
    expect(areaRating(rate(events, tagged, rulesV0, littleLeague), "baserunning")).toBe(6);
  });

  it("filters areas by the requested rule set", () => {
    const highSchool = retag("pitching.pickoffs", ["high-school"]);
    const events = sameDayDrills("pitching.pickoffs", 2);
    const card = rate(events, highSchool, rulesV0, { ruleset: "high-school" });
    expect(card.areas).toStrictEqual([{ area: "pitching", rating: 1 }]);
    expect(card.overall).toBe(1);
  });

  it("excludes an area with no rule-set skills from overall", () => {
    const events = [
      ...readyPosition,
      ...sameDayDrills("mental.failure", 10, 11),
      ...sameDayDrills("first-base.holding-runner", 100, 21),
    ];
    const card = rate(events, taxonomyV0, rulesV0, littleLeague);
    expect(card.skills.map((entry) => [entry.skill, entry.rating])).toStrictEqual([
      ["infield.ready-position", 15],
      ["mental.failure", 15],
      ["first-base.holding-runner", 56],
    ]);
    expect(card.areas.map((entry) => entry.area)).toStrictEqual(littleLeagueAreas);
    expect(card.overall).toBe(2);
  });
});

describe("mental.failure", () => {
  it("is a tier 1 Little League skill in the mental area", () => {
    expect(taxonomyV0.skills.find((skill) => skill.id === "mental.failure")).toMatchObject({
      area: "mental",
      tier: 1,
      status: "active",
      rulesets: ["little-league"],
    });
  });

  it("rates the mental area and lifts overall", () => {
    const card = rate(sameDayDrills("mental.failure", 10), taxonomyV0, rulesV0, littleLeague);
    expect(areaRating(card, "mental")).toBe(15);
    expect(card.overall).toBe(1);
  });
});
