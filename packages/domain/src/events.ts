import { z } from "zod";
import {
  attendanceRecordIdSchema,
  entityMetadataSchema,
  eventOccurrenceIdSchema,
  eventSeriesIdSchema,
  isoTimestampSchema,
  localDateSchema,
  participantIdSchema,
  seasonIdSchema,
  teamIdSchema,
  uniqueArray,
} from "./primitives";

const metadata = entityMetadataSchema.shape;

export const eventKindSchema = z.enum(["practice", "game", "other"]);
export type EventKind = z.infer<typeof eventKindSchema>;

/** A wall-clock time of day, 24-hour, zero-padded — "17:00". */
export const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Expected a 24-hour HH:MM time");

export const weekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type Weekday = z.infer<typeof weekdaySchema>;

/**
 * The schedule half of a series: wall time plus IANA zone, and either a single
 * date or a bounded weekly repetition. The UNTIL date is required exactly when
 * the schedule repeats — an unbounded series would have no whole-series
 * materialization (ADR 0009), so the type refuses to describe one.
 */
export const eventScheduleSchema = z
  .strictObject({
    timeZone: z.string().trim().min(1),
    localTime: localTimeSchema,
    durationMinutes: z.int().min(5).max(1_440),
    frequency: z.enum(["once", "weekly"]),
    byWeekday: uniqueArray(weekdaySchema).min(1).max(7).optional(),
    startDate: localDateSchema,
    untilDate: localDateSchema.optional(),
  })
  .refine((schedule) => (schedule.frequency === "weekly") === (schedule.byWeekday !== undefined), {
    message: "byWeekday is required for weekly schedules and forbidden otherwise",
    path: ["byWeekday"],
  })
  .refine((schedule) => (schedule.frequency === "weekly") === (schedule.untilDate !== undefined), {
    message: "untilDate is required for weekly schedules and forbidden otherwise",
    path: ["untilDate"],
  })
  .refine(
    (schedule) => schedule.untilDate === undefined || schedule.untilDate >= schedule.startDate,
    {
      message: "Until date must not precede start date",
      path: ["untilDate"],
    },
  );
export type EventSchedule = z.infer<typeof eventScheduleSchema>;

export const eventSeriesSchema = z.strictObject({
  id: eventSeriesIdSchema,
  teamId: teamIdSchema,
  seasonId: seasonIdSchema,
  title: z.string().trim().min(1),
  kind: eventKindSchema,
  location: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  timeZone: z.string().trim().min(1),
  localTime: localTimeSchema,
  durationMinutes: z.int().min(5).max(1_440),
  frequency: z.enum(["once", "weekly"]),
  byWeekday: uniqueArray(weekdaySchema).optional(),
  startDate: localDateSchema,
  untilDate: localDateSchema.optional(),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type EventSeries = z.infer<typeof eventSeriesSchema>;

export const eventOccurrenceSchema = z.strictObject({
  id: eventOccurrenceIdSchema,
  seriesId: eventSeriesIdSchema,
  localDate: localDateSchema,
  /** The derived UTC instant this occurrence starts — see ADR 0009. */
  startsAt: isoTimestampSchema,
  durationMinutes: z.int().min(5).max(1_440),
  status: z.enum(["scheduled", "cancelled"]),
  cancelledReason: z.string().trim().min(1).optional(),
  ...metadata,
});
export type EventOccurrence = z.infer<typeof eventOccurrenceSchema>;

export const attendanceStatusSchema = z.enum(["yes", "no", "maybe"]);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

export const attendanceRecordSchema = z.strictObject({
  id: attendanceRecordIdSchema,
  occurrenceId: eventOccurrenceIdSchema,
  participantId: participantIdSchema,
  status: attendanceStatusSchema,
  ...metadata,
});
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;
