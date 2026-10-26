import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillEvents, rate, rulesV0, taxonomyV0, type RateOptions } from "./index";

const fixturesDir = fileURLToPath(new URL("../fixtures/skill-events-v0/", import.meta.url));
const fixtureNames = readdirSync(fixturesDir)
  .filter((file) => file.endsWith(".json"))
  .toSorted();

interface Fixture {
  readonly options: RateOptions;
  readonly events: unknown;
  readonly expected: unknown;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8")) as Fixture;
}

describe("skill.events/v0 golden fixtures", () => {
  it("covers the required cases", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fixtureNames)("%s", (name) => {
    const fixture = loadFixture(name);
    const events = parseSkillEvents(fixture.events);
    const expected = fixture.expected;
    if (typeof expected === "object" && expected !== null && "error" in expected) {
      expect(() => rate(events, taxonomyV0, rulesV0, fixture.options)).toThrowError(
        String(expected.error),
      );
      return;
    }
    expect(rate(events, taxonomyV0, rulesV0, fixture.options)).toStrictEqual(expected);
  });
});
