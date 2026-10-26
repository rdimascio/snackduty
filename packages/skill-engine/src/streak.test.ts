import { describe, expect, it } from "vitest";
import { buildStreakTimeline, rulesV0, streakMultiplier } from "./index";

const date = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);
const timelineFor = (days: readonly number[]) =>
  buildStreakTimeline(
    days.map((day) => date(day)),
    rulesV0.restDay,
  );
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("streak multiplier table", () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1.25],
    [6, 1.25],
    [7, 1.5],
    [13, 1.5],
    [14, 1.75],
    [29, 1.75],
    [30, 2],
    [365, 2],
  ])("a %i-day streak multiplies by %d", (days, multiplier) => {
    expect(streakMultiplier(days, rulesV0.streak)).toBe(multiplier);
  });

  it.each([
    [2, 3],
    [6, 7],
    [13, 14],
    [29, 30],
  ])("steps up from day %i to day %i of consecutive training", (before, after) => {
    const timeline = timelineFor(range(1, 31));
    expect(timeline.on(date(before))).toBe(before);
    expect(timeline.on(date(after))).toBe(after);
    expect(streakMultiplier(timeline.on(date(after)), rulesV0.streak)).toBeGreaterThan(
      streakMultiplier(timeline.on(date(before)), rulesV0.streak),
    );
  });
});

describe("streak timeline", () => {
  it("is 0 before any training", () => {
    expect(buildStreakTimeline([], rulesV0.restDay).on(date(1))).toBe(0);
    expect(timelineFor([5]).on(date(4))).toBe(0);
  });

  it("counts consecutive training days regardless of input order or duplicates", () => {
    expect(timelineFor([3, 1, 2, 2]).on(date(3))).toBe(3);
  });

  it("keeps the streak today when the last training day was yesterday", () => {
    expect(timelineFor([1, 2, 3]).on(date(4))).toBe(3);
  });

  it("bridges a single rest day without adding it to the length", () => {
    const timeline = timelineFor([1, 2, 3, 5]);
    expect(timeline.on(date(5))).toBe(4);
    expect(timeline.on(date(4))).toBe(3);
  });

  it("keeps the streak alive on the day after a bridgeable rest day", () => {
    expect(timelineFor([1, 2, 3]).on(date(5))).toBe(3);
  });

  it("allows a second rest day 7 days after the first", () => {
    expect(timelineFor([1, ...range(3, 8), 10]).on(date(10))).toBe(8);
  });

  it("resets on a second rest day inside the 6-day window", () => {
    expect(timelineFor([1, ...range(3, 7), 9]).on(date(9))).toBe(1);
  });

  it("resets on two missed days in a row", () => {
    const timeline = timelineFor([1, 2, 3, 6]);
    expect(timeline.on(date(6))).toBe(1);
    expect(timelineFor([1, 2, 3]).on(date(6))).toBe(0);
  });

  it("starts a fresh rest-day window after a reset", () => {
    expect(timelineFor([1, 3, 6, 8]).on(date(8))).toBe(2);
  });
});
