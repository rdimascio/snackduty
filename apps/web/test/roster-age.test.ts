import { describe, expect, it } from "vitest";

import { ageOn, localDateIn } from "../app/roster/age";

describe("roster age", () => {
  it("counts whole years and waits for the birthday", () => {
    expect(ageOn("2018-04-09", "2026-10-26")).toBe(8);
    expect(ageOn("2019-11-01", "2026-10-26")).toBe(6);
    expect(ageOn("2019-10-26", "2026-10-26")).toBe(7);
    expect(ageOn("2019-10-27", "2026-10-26")).toBe(6);
  });

  it("treats a leap-day birthday as reached on March 1", () => {
    expect(ageOn("2016-02-29", "2026-02-28")).toBe(9);
    expect(ageOn("2016-02-29", "2026-03-01")).toBe(10);
  });

  it("refuses a malformed or future birth date", () => {
    expect(ageOn("April 2018", "2026-10-26")).toBeUndefined();
    expect(ageOn("2027-01-01", "2026-10-26")).toBeUndefined();
  });

  it("reads today in the season's time zone", () => {
    const lateEveningPacific = Date.UTC(2026, 9, 27, 5);
    expect(localDateIn(lateEveningPacific, "America/Los_Angeles")).toBe("2026-10-26");
    expect(localDateIn(lateEveningPacific, "UTC")).toBe("2026-10-27");
    expect(localDateIn(lateEveningPacific, "Not/AZone")).toBe("2026-10-27");
  });
});
