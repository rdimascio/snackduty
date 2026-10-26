import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_MODULE_CONTRACT, type ModuleDrill, skillModuleSchema } from "./index";

const modulePath = fileURLToPath(new URL("../modules/cutoffs-and-relays.v1.json", import.meta.url));
const cutoffsJson: unknown = JSON.parse(readFileSync(modulePath, "utf8"));

const cutoffSkills = ["infield.cutoff-lead", "infield.cutoff-trail", "outfield.hit-the-cutoff"];

const baseReceivers = {
  first: /\bat first base\b/iu,
  second: /\bat second base\b/iu,
  third: /\bat third base\b/iu,
  home: /\bat home plate\b/iu,
} as const;
type Base = keyof typeof baseReceivers;

const throwPattern = /\bthrow/iu;
const throwTargetPattern =
  /\b(?:to|at|toward)\s+(first|second|third)\b(?!\s+baseman)|\b(home)\b/giu;

function isBase(value: string): value is Base {
  return Object.hasOwn(baseReceivers, value);
}

function throwTargets(drill: Pick<ModuleDrill, "steps" | "coachingPoints">): Set<Base> {
  const targets = new Set<Base>();
  const sentences = [...drill.steps, ...drill.coachingPoints].flatMap((line) =>
    line.split(/[.!?]/u),
  );
  for (const sentence of sentences.filter((line) => throwPattern.test(line))) {
    for (const match of sentence.matchAll(throwTargetPattern)) {
      const base = (match[1] ?? match[2] ?? "").toLowerCase();
      if (isBase(base)) {
        targets.add(base);
      }
    }
  }
  return targets;
}

function basesWithoutReceiver(
  drill: Pick<ModuleDrill, "setup" | "steps" | "coachingPoints">,
): Base[] {
  return [...throwTargets(drill)].filter((base) => !baseReceivers[base].test(drill.setup));
}

function validModule() {
  return {
    contract: SKILL_MODULE_CONTRACT,
    id: "sample-module",
    version: 1,
    skill: "infield.cutoff-lead",
    ageMin: 10,
    lessons: [
      {
        id: "sample-lesson",
        title: "Sample lesson",
        script: ["Line up on the throw."],
        diagram: {
          kind: "field",
          positions: [
            { id: "left-fielder", label: "LF", x: 20, y: 30 },
            { id: "shortstop", label: "SS", x: 40, y: 55 },
          ],
          arrows: [{ from: "left-fielder", to: "shortstop", kind: "throw" }],
        },
        video: { releaseId: "rel-001", url: "https://example.com/video.mp4" },
      },
    ],
    checks: [
      {
        id: "sample-check",
        prompt: "Who calls the cut?",
        choices: ["The cutoff", "The catcher"],
        answer: 1,
        feedback: { correct: "Yes.", wrong: "Try again." },
      },
    ],
    drills: [
      {
        id: "sample-drill",
        title: "Sample drill",
        skill: "outfield.hit-the-cutoff",
        setup: "Two players, 90 feet apart.",
        steps: ["Throw at the head."],
        reps: "10 throws.",
        coachingPoints: ["Hands up."],
      },
    ],
  };
}

describe("cutoffs and relays module v1", () => {
  it("parses the cutoffs and relays module", () => {
    const parsed = skillModuleSchema.parse(cutoffsJson);
    expect(parsed.id).toBe("cutoffs-and-relays");
    expect(parsed.lessons).toHaveLength(5);
    expect(parsed.checks).toHaveLength(4);
    expect(parsed.drills).toHaveLength(6);
  });

  it("keeps every cutoffs drill on one of the module's three skills", () => {
    const parsed = skillModuleSchema.parse(cutoffsJson);
    expect(cutoffSkills).toContain(parsed.skill);
    for (const drill of parsed.drills) {
      expect(cutoffSkills).toContain(drill.skill);
    }
    expect(new Set(parsed.drills.map((drill) => drill.skill))).toEqual(new Set(cutoffSkills));
  });

  it("puts a receiver in the setup at every base a drill throws to", () => {
    const parsed = skillModuleSchema.parse(cutoffsJson);
    for (const drill of parsed.drills) {
      expect({ drill: drill.id, missing: basesWithoutReceiver(drill) }).toEqual({
        drill: drill.id,
        missing: [],
      });
    }
    const allTargets = new Set(parsed.drills.flatMap((drill) => [...throwTargets(drill)]));
    expect(allTargets).toEqual(new Set(["second", "third", "home"]));
  });

  it("flags a drill that throws to a base with no receiver in its setup", () => {
    const drill = {
      setup: "Put a cutoff between the outfielder and second base.",
      steps: ["The cutoff catches it and throws to second base.", "Throw it home on a relay call."],
      coachingPoints: ["Throw to the second baseman."],
    };
    expect(basesWithoutReceiver(drill)).toEqual(["second", "home"]);
  });

  it("does not teach the retired rules", () => {
    const text = JSON.stringify(cutoffsJson).toLowerCase();
    expect(text).not.toContain("a little high");
    expect(text).not.toContain("keep the throw low");
    expect(text).not.toContain("the cutoff is the lead player");
    expect(text).not.toContain("do not touch it");
  });
});

describe("skill.module/v0 validation", () => {
  it("accepts a minimal valid module with a diagram and a video", () => {
    expect(skillModuleSchema.safeParse(validModule()).success).toBe(true);
  });

  it("rejects an unknown module skill", () => {
    const module = { ...validModule(), skill: "infield.made-up" };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });

  it("rejects an unknown drill skill", () => {
    const base = validModule();
    const module = { ...base, drills: [{ ...base.drills[0], skill: "outfield.made-up" }] };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });

  it("rejects a duplicate item id across lessons, checks and drills", () => {
    const base = validModule();
    const module = { ...base, drills: [{ ...base.drills[0], id: "sample-lesson" }] };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });

  it("rejects an out-of-range check answer", () => {
    const base = validModule();
    const module = { ...base, checks: [{ ...base.checks[0], answer: 2 }] };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });

  it("rejects a video with no release id", () => {
    const base = validModule();
    const module = {
      ...base,
      lessons: [{ ...base.lessons[0], video: { url: "https://example.com/video.mp4" } }],
    };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });

  it("rejects ids that are not kebab-case", () => {
    const module = { ...validModule(), id: "Sample_Module" };
    expect(skillModuleSchema.safeParse(module).success).toBe(false);
  });
});
