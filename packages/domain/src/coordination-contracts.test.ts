import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createEventInputSchema,
  createEventResponseSchema,
  seasonEventsResponseSchema,
  attendanceReadResponseSchema,
  attendanceResponseSchema,
  dutySlotsResponseSchema,
  dutySlotResponseSchema,
} from "./coordination-contracts";

describe("canonical coordination contracts", () => {
  for (const [name, schema] of [
    ["event-create-input", createEventInputSchema],
    ["event-created", createEventResponseSchema],
    ["season-events", seasonEventsResponseSchema],
    ["attendance-own-child", attendanceReadResponseSchema],
    ["attendance-recorded", attendanceResponseSchema],
    ["duty-slots", dutySlotsResponseSchema],
    ["duty-claimed", dutySlotResponseSchema],
  ] as const) {
    it(`validates ${name}`, () => {
      const data: unknown = JSON.parse(
        readFileSync(new URL(`../../../contracts/fixtures/${name}.json`, import.meta.url), "utf8"),
      );
      expect(schema.safeParse(data).success).toBe(true);
    });
  }
});
