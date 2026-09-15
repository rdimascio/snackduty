import { z } from "zod";
import {
  attendanceStatusSchema,
  eventKindSchema,
  eventOccurrenceSchema,
  eventScheduleSchema,
  eventSeriesSchema,
} from "./events";
import { isoTimestampSchema } from "./primitives";

export const dutySlotInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(2_000).optional(),
});

export const createEventInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    kind: eventKindSchema,
    location: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().min(1).max(2_000).optional(),
    schedule: eventScheduleSchema,
    requestId: z.uuid().optional(),
    snackDuty: dutySlotInputSchema.optional(),
  })
  .refine((input) => input.snackDuty === undefined || input.schedule.frequency === "once", {
    message: "Create a snack duty with a single event.",
    path: ["snackDuty"],
  });

export const attendanceCountsSchema = z.strictObject({
  yes: z.int().nonnegative(),
  no: z.int().nonnegative(),
  maybe: z.int().nonnegative(),
});
export const scheduleOccurrenceSchema = eventOccurrenceSchema.extend({
  attendance: attendanceCountsSchema,
});
export const scheduleEventSchema = z.strictObject({
  series: eventSeriesSchema,
  occurrences: z.array(scheduleOccurrenceSchema),
});
export const seasonEventsResponseSchema = z.strictObject({ events: z.array(scheduleEventSchema) });

export const dutySlotSchema = z.strictObject({
  id: z.string().min(1),
  occurrenceId: z.string().min(1),
  label: z.string().min(1),
  instructions: z.string().min(1).optional(),
  assignee: z.strictObject({ personId: z.string().min(1), displayName: z.string() }).optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export const dutySlotsResponseSchema = z.strictObject({ dutySlots: z.array(dutySlotSchema) });
export const dutySlotResponseSchema = z.strictObject({ dutySlot: dutySlotSchema });
export const createEventResponseSchema = z.strictObject({
  series: eventSeriesSchema,
  occurrences: z.array(eventOccurrenceSchema),
  dutySlots: z.array(dutySlotSchema),
});
export const attendanceInputSchema = z.strictObject({
  participantId: z.string().trim().min(1),
  status: attendanceStatusSchema,
});
export const attendanceResponseSchema = z.strictObject({ attendance: attendanceInputSchema });
export const attendanceReadResponseSchema = z.strictObject({
  attendance: z.strictObject({
    counts: attendanceCountsSchema,
    entries: z.array(attendanceInputSchema.extend({ displayName: z.string() })),
    // Hints for this caller's current authority; writes authorize again.
    responseOptions: z.array(
      z.strictObject({
        participantId: z.string().min(1),
        displayName: z.string(),
        status: attendanceStatusSchema.optional(),
      }),
    ),
  }),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type CreateEventResponse = z.infer<typeof createEventResponseSchema>;
export type SeasonEventsResponse = z.infer<typeof seasonEventsResponseSchema>;
export type AttendanceInput = z.infer<typeof attendanceInputSchema>;
export type AttendanceResponse = z.infer<typeof attendanceResponseSchema>;
export type AttendanceReadResponse = z.infer<typeof attendanceReadResponseSchema>;
export type DutySlotsResponse = z.infer<typeof dutySlotsResponseSchema>;
export type DutySlotResponse = z.infer<typeof dutySlotResponseSchema>;
