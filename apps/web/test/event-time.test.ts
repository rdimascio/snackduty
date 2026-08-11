import { describe, expect, it } from "vitest";

import {
  addDays,
  instantFromWallTime,
  isValidTimeZone,
  scheduleDates,
  weekdayOf,
} from "../app/lib/server/event-time";

describe("time zone validation", () => {
  it("accepts real IANA zone names", () => {
    for (const zone of ["America/Los_Angeles", "Europe/Berlin", "UTC", "Pacific/Auckland"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const zone of ["Not/AZone", "PST or so", "America/Los_Angeles_X", ""]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });
});

describe("wall time to instant", () => {
  it("derives plain UTC and fixed-offset wall times", () => {
    expect(instantFromWallTime("2026-01-01", "09:30", "UTC")).toBe("2026-01-01T09:30:00.000Z");
    // Phoenix never observes DST: -7 all year.
    expect(instantFromWallTime("2026-07-04", "12:00", "America/Phoenix")).toBe(
      "2026-07-04T19:00:00.000Z",
    );
  });

  // THE slice's core promise (ADR 0009): a 5:00pm Tuesday practice is 5:00pm
  // LOCAL on both sides of a DST transition, so the UTC instants differ by an
  // hour. America/Los_Angeles springs forward 2026-03-08 and falls back
  // 2026-11-01.
  it("keeps 17:00 local across the America/Los_Angeles spring-forward", () => {
    // Tuesday before (PST, UTC-8) and Tuesday after (PDT, UTC-7).
    expect(instantFromWallTime("2026-03-03", "17:00", "America/Los_Angeles")).toBe(
      "2026-03-04T01:00:00.000Z",
    );
    expect(instantFromWallTime("2026-03-10", "17:00", "America/Los_Angeles")).toBe(
      "2026-03-11T00:00:00.000Z",
    );
  });

  it("keeps 17:00 local across the America/Los_Angeles fall-back", () => {
    // Tuesday before (PDT) and Tuesday after (PST).
    expect(instantFromWallTime("2026-10-27", "17:00", "America/Los_Angeles")).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(instantFromWallTime("2026-11-03", "17:00", "America/Los_Angeles")).toBe(
      "2026-11-04T01:00:00.000Z",
    );
  });

  it("keeps 17:00 local across the Europe/Berlin spring-forward too", () => {
    // Berlin springs forward 2026-03-29: CET (+1) before, CEST (+2) after.
    expect(instantFromWallTime("2026-03-28", "17:00", "Europe/Berlin")).toBe(
      "2026-03-28T16:00:00.000Z",
    );
    expect(instantFromWallTime("2026-03-30", "17:00", "Europe/Berlin")).toBe(
      "2026-03-30T15:00:00.000Z",
    );
  });

  it("resolves a wall time the spring-forward gap skips deterministically", () => {
    // 02:30 does not exist on 2026-03-08 in Los Angeles (02:00 jumps to
    // 03:00). The two-pass correction lands on a stable nearby instant —
    // the value matters less than that it is ONE value, every time.
    const resolved = instantFromWallTime("2026-03-08", "02:30", "America/Los_Angeles");
    expect(resolved).toBe("2026-03-08T09:30:00.000Z");
    expect(instantFromWallTime("2026-03-08", "02:30", "America/Los_Angeles")).toBe(resolved);
  });

  it("resolves an ambiguous fall-back wall time deterministically", () => {
    // 01:30 happens twice on 2026-11-01 in Los Angeles; the derivation picks
    // the first (PDT) reading, every time.
    expect(instantFromWallTime("2026-11-01", "01:30", "America/Los_Angeles")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });

  it("refuses malformed dates and times", () => {
    expect(() => instantFromWallTime("2026-3-3", "17:00", "UTC")).toThrow();
    expect(() => instantFromWallTime("2026-03-03", "25:00", "UTC")).toThrow();
    expect(() => instantFromWallTime("2026-03-03", "5:00", "UTC")).toThrow();
  });
});

describe("civil date arithmetic", () => {
  it("names weekdays", () => {
    expect(weekdayOf("2026-03-08")).toBe("sunday");
    expect(weekdayOf("2026-03-03")).toBe("tuesday");
    expect(weekdayOf("2026-08-03")).toBe("monday");
    // Proleptic Gregorian at both ends of what the date schema accepts —
    // years under 100 are the ones a bare `Date.UTC` folds into the 1900s.
    expect(weekdayOf("0050-01-01")).toBe("saturday");
    expect(weekdayOf("9999-12-31")).toBe("friday");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("refuses to step off the end of the calendar", () => {
    // The day after 9999-12-31 is the expanded-year "+010000-01-01", which
    // sliced to ten characters sorts BEFORE every date it came from. Returning
    // it is how a date cursor used to walk past its own bound.
    expect(() => addDays("9999-12-31", 1)).toThrow(
      "Civil date arithmetic left the four-digit year range.",
    );
  });
});

describe("schedule date enumeration", () => {
  const cap = 201;

  it("a once schedule is exactly its start date", () => {
    expect(scheduleDates({ frequency: "once", startDate: "2026-05-01" }, cap)).toEqual([
      "2026-05-01",
    ]);
  });

  it("a weekly schedule hits each selected weekday, inclusive on both ends", () => {
    expect(
      scheduleDates(
        {
          frequency: "weekly",
          byWeekday: ["tuesday", "thursday"],
          startDate: "2026-03-03",
          untilDate: "2026-03-12",
        },
        cap,
      ),
    ).toEqual(["2026-03-03", "2026-03-05", "2026-03-10", "2026-03-12"]);
  });

  it("a weekly schedule whose range misses every selected weekday is empty", () => {
    expect(
      scheduleDates(
        {
          frequency: "weekly",
          byWeekday: ["monday"],
          startDate: "2026-03-03",
          untilDate: "2026-03-06",
        },
        cap,
      ),
    ).toEqual([]);
  });

  it("stops at the emit cap instead of finishing the range", () => {
    expect(
      scheduleDates(
        {
          frequency: "weekly",
          byWeekday: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          startDate: "2026-03-03",
          untilDate: "2026-12-31",
        },
        4,
      ),
    ).toEqual(["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]);
  });

  it("bounds the widest schema-valid range instead of enumerating it", () => {
    // Uncapped this walks 3.6 million civil days synchronously — event-loop
    // blocking every other request can neither preempt nor outwait.
    const started = performance.now();
    const dates = scheduleDates(
      {
        frequency: "weekly",
        byWeekday: ["monday"],
        startDate: "0100-01-01",
        untilDate: "9998-12-31",
      },
      cap,
    );
    expect(dates).toHaveLength(cap);
    // The capped walk stops after ~1,400 iterations and costs well under a
    // millisecond; the uncapped one is three orders of magnitude slower.
    expect(performance.now() - started).toBeLessThan(25);
  });

  it("walks the last representable civil date without leaving the calendar", () => {
    expect(
      scheduleDates(
        {
          frequency: "weekly",
          byWeekday: ["friday"],
          startDate: "9999-12-31",
          untilDate: "9999-12-31",
        },
        cap,
      ),
    ).toEqual(["9999-12-31"]);
    // The cursor has to step PAST 9999-12-31 to end this walk, which is the
    // step that used to throw and answer a 500 from a schema-valid schedule.
    expect(
      scheduleDates(
        {
          frequency: "weekly",
          byWeekday: ["monday"],
          startDate: "9999-12-20",
          untilDate: "9999-12-31",
        },
        cap,
      ),
    ).toEqual(["9999-12-20", "9999-12-27"]);
  });
});
