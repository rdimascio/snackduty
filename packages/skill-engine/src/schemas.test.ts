import { describe, expect, it } from "vitest";
import {
  rulesSchema,
  rulesV0,
  SKILL_EVENTS_CONTRACT,
  skillEventSchema,
  taxonomySchema,
  taxonomyV0,
} from "./index";

const drill = {
  contract: SKILL_EVENTS_CONTRACT,
  id: "evt_01J",
  playerId: "plr_01J",
  type: "drill_completed",
  skill: "infield.cutoff-lead",
  source: {
    kind: "module",
    id: "cutoffs-and-relays",
    version: 1,
    itemId: "lead-relay-double-down-the-line",
  },
  occurredAt: "2026-10-26T15:04:05Z",
  localDate: "2026-10-26",
  app: "ballplayer",
};

const readyPosition = {
  id: "infield.ready-position",
  area: "infield",
  tier: 1,
  ageMin: 5,
  status: "active",
};

function taxonomy(skills: unknown[]) {
  return { contract: "skill.taxonomy/v0", areas: ["infield"], skills };
}

describe("taxonomy v0", () => {
  it("holds the spec example skills at their tiers", () => {
    const tierOf = new Map(taxonomyV0.skills.map((skill) => [skill.id, skill.tier]));
    expect(Object.fromEntries(tierOf)).toMatchObject({
      "infield.ready-position": 1,
      "baserunning.out-of-the-box": 1,
      "baserunning.leads": 2,
      "outfield.hit-the-cutoff": 2,
      "bunting.sacrifice": 2,
      "infield.cutoff-lead": 3,
      "infield.cutoff-trail": 3,
      "baserunning.hook-slide": 3,
      "infield.throw-on-the-run": 3,
      "first-base.holding-runner": 4,
      "hitting.approach-by-count": 4,
      "pitching.pickoffs": 4,
      "baseball-iq.history": 1,
    });
  });

  it("lists the spec areas", () => {
    expect(taxonomyV0.areas).toStrictEqual([
      "hitting",
      "bunting",
      "baserunning",
      "infield",
      "outfield",
      "first-base",
      "pitching",
      "catching",
      "baseball-iq",
    ]);
  });

  it("rejects a duplicate skill id", () => {
    expect(taxonomySchema.safeParse(taxonomy([readyPosition, readyPosition])).success).toBe(false);
  });

  it("rejects a skill id that is not kebab-case", () => {
    expect(
      taxonomySchema.safeParse(taxonomy([{ ...readyPosition, id: "infield.Ready_Position" }]))
        .success,
    ).toBe(false);
  });

  it("rejects a skill id outside its area", () => {
    expect(
      taxonomySchema.safeParse(taxonomy([{ ...readyPosition, id: "outfield.ready-position" }]))
        .success,
    ).toBe(false);
  });

  it("rejects a skill in an unknown area", () => {
    expect(
      taxonomySchema.safeParse(
        taxonomy([{ ...readyPosition, id: "catching.framing", area: "catching" }]),
      ).success,
    ).toBe(false);
  });
});

describe("rules v0", () => {
  it("pins the streak table", () => {
    expect(rulesV0.streak).toStrictEqual([
      { minDays: 1, multiplier: 1 },
      { minDays: 3, multiplier: 1.25 },
      { minDays: 7, multiplier: 1.5 },
      { minDays: 14, multiplier: 1.75 },
      { minDays: 30, multiplier: 2 },
    ]);
  });

  it("rejects a streak table that does not rise", () => {
    expect(
      rulesSchema.safeParse({
        ...rulesV0,
        streak: [
          { minDays: 1, multiplier: 1 },
          { minDays: 3, multiplier: 0.5 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("skill.events/v0", () => {
  it("accepts the spec example event", () => {
    expect(skillEventSchema.parse(drill)).toStrictEqual(drill);
  });

  it("accepts every v0 event type", () => {
    const source = { kind: "reel-episode", id: "baseball-basics/cutoffs", itemId: "q1" };
    const events = [
      { ...drill, id: "evt_2", type: "module_completed" },
      { ...drill, id: "evt_3", type: "check_passed", source },
      { ...drill, id: "evt_4", type: "history_learned", skill: "baseball-iq.history", source },
      { ...drill, id: "evt_5", type: "high_five", source: { kind: "coach", id: "plr_coach" } },
      {
        ...drill,
        id: "evt_6",
        type: "card_collected",
        skill: undefined,
        source: { kind: "milestone", id: "first-streak" },
      },
      {
        ...drill,
        id: "evt_7",
        type: "void",
        skill: undefined,
        source: undefined,
        voids: "evt_01J",
      },
    ].map((event) => JSON.parse(JSON.stringify(event)) as unknown);
    for (const event of events) {
      expect(skillEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it.each(["skill.events/v1", "skill.event/v0", "reel.episode/v0"])(
    "rejects contract %s",
    (contract) => {
      expect(skillEventSchema.safeParse({ ...drill, contract }).success).toBe(false);
    },
  );

  it("rejects an unknown event type", () => {
    expect(skillEventSchema.safeParse({ ...drill, type: "drill_started" }).success).toBe(false);
  });

  it("rejects free text fields", () => {
    expect(skillEventSchema.safeParse({ ...drill, note: "great job" }).success).toBe(false);
    expect(
      skillEventSchema.safeParse({ ...drill, source: { ...drill.source, itemId: "Great job!" } })
        .success,
    ).toBe(false);
  });

  it("requires a module version on module_completed", () => {
    expect(
      skillEventSchema.safeParse({
        ...drill,
        type: "module_completed",
        source: { kind: "module", id: "cutoffs-and-relays" },
      }).success,
    ).toBe(false);
  });

  it("routes history_learned only to baseball-iq.history", () => {
    expect(skillEventSchema.safeParse({ ...drill, type: "history_learned" }).success).toBe(false);
  });
});
