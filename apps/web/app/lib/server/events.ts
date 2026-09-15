import type { Clock } from "./application-contracts";
/**
 * Events: recurring series with MATERIALIZED occurrences (ADR 0009).
 *
 * A series stores the human agreement — "practice, 5:00pm Tuesdays, America/
 * Los_Angeles, through June" — and every date it names becomes a durable
 * `event_occurrences` row in the same transaction, unique on
 * `(series_id, local_date)`. Attendance, cancellation, and (later) duties
 * attach to those rows, so nothing is ever computed-then-lost at read time.
 *
 * Time is wall time plus IANA zone on the series; each occurrence stores the
 * UTC instant that wall time means on ITS date (event-time.ts) — which is what
 * keeps a 5:00pm practice at 5:00pm local across a DST transition.
 *
 * A schedule edit replaces the definition and reconciles BY LOCAL DATE: kept
 * dates keep their occurrence row (same id — attendance and cancellation
 * survive, instants recomputed), new dates gain one, and a FUTURE date the new
 * schedule dropped is CANCELLED with the reserved reason below — never
 * deleted. Past occurrences are never touched by a removed date. A future date
 * that COMES BACK is reinstated when — and only when — it carries that
 * reserved reason: the machine cancel said "this date left the schedule", and
 * the date returning makes that false. An edit can therefore neither orphan
 * nor duplicate what already exists, and edit-then-undo is a round trip.
 *
 * Cancelling an occurrence is a STATE with a required reason; the row stays
 * visible and re-cancelling is an idempotent no-op that keeps the original
 * reason. A human cancellation is never reversed by a schedule edit, which is
 * why the cancel endpoint refuses the reserved reason. Nothing here deletes
 * history.
 */

import { and, createTableSql, defineTable, dropTableSql, eq, inList, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import {
  createEventInputSchema,
  createEventResponseSchema,
  attendanceStatusSchema,
  eventKindSchema,
  eventOccurrenceSchema,
  eventScheduleSchema,
  eventSeriesSchema,
  seasonEventsResponseSchema,
} from "@snackday/domain";
import type { CreateEventInput, EventSchedule } from "@snackday/domain";
import { z } from "zod";

import type { SessionService as Sessions } from "./application-contracts";
import { activeApplicationActor } from "./coordination-actor";
import type {
  ApplicationActor,
  CoordinationOperations,
  CoordinationResult,
  CoordinationServices,
} from "./coordination-contracts";
import { insertDutySlot, projectedDutySlot } from "./duties";
import { eventCreationReceipts } from "./event-creation-receipts";
import { instantFromWallTime, isValidTimeZone, scheduleDates } from "./event-time";
import { authenticatedAdult, people } from "./identity";
import {
  activeOccurrenceForOperation,
  activeSeasonForOperation,
  activeSeriesForOperation,
  eventOccurrences,
  eventSeries,
} from "./occurrence-access";
import { participants } from "./roster";
import { manageableActiveTeam, readableActiveTeam } from "./teams";

export { eventOccurrences, eventSeries } from "./occurrence-access";

// One row per (occurrence, child): the child's current answer, upserted.
// `recorded_by_person_id` is an AUDIT column — which adult wrote the row —
// and is never projected to any reader.
export const eventAttendance = defineTable("event_attendance", {
  id: text("id").primaryKey(),
  occurrenceId: text("occurrence_id")
    .notNull()
    .references(() => eventOccurrences.id),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id),
  status: text("status").notNull(),
  recordedByPersonId: text("recorded_by_person_id")
    .notNull()
    .references(() => people.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createEvents: MigrationEntry = {
  version: "007_create_events",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(eventSeries));
      schema.execute(createTableSql(eventOccurrences));
      schema.execute(createTableSql(eventAttendance));
      schema.execute("CREATE INDEX event_series_team_id_idx ON event_series (team_id)");
      schema.execute(
        "CREATE UNIQUE INDEX event_occurrences_series_local_date_idx ON event_occurrences (series_id, local_date)",
      );
      schema.execute(
        "CREATE INDEX event_occurrences_team_starts_idx ON event_occurrences (team_id, starts_at_utc)",
      );
      schema.execute(
        "CREATE UNIQUE INDEX event_attendance_occurrence_participant_idx ON event_attendance (occurrence_id, participant_id)",
      );
    },
    down: (schema) => {
      schema.execute(dropTableSql(eventAttendance));
      schema.execute(dropTableSql(eventOccurrences));
      schema.execute(dropTableSql(eventSeries));
    },
  },
};

/**
 * The whole-series materialization bound (ADR 0009): a schedule may not name
 * more dates than this. Practically generous — a 6-month season of daily
 * events fits — and it keeps "create a series" a bounded write.
 */
export const MAX_SERIES_OCCURRENCES = 200;

/**
 * The reason a schedule edit writes onto a future occurrence it dropped, and
 * the marker that lets a later edit reinstate that occurrence when the date
 * returns. It must therefore mean "the machine did this" and nothing else — a
 * human who typed it would have their cancellation silently undone, so the
 * cancel endpoint refuses it.
 */
export const RESCHEDULE_CANCEL_REASON = "Removed by schedule change";

export const eventSeriesInputSchema = z.strictObject({
  title: z.string().trim().min(1, "Event title is required.").max(200),
  kind: eventKindSchema,
  location: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().min(1).max(2_000).optional(),
  schedule: eventScheduleSchema,
});

const seasonTargetSchema = z.strictObject({
  teamId: z.string().trim().min(1),
  seasonId: z.string().trim().min(1),
});
const createEventCommandSchema = seasonTargetSchema.extend({ input: createEventInputSchema });

export const cancelOccurrenceInputSchema = z.strictObject({
  reason: z.string().trim().min(1, "A cancellation reason is required.").max(500),
});

export const recordAttendanceInputSchema = z.strictObject({
  participantId: z.string().trim().min(1),
  status: attendanceStatusSchema,
});

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const eventNotFound = { error: "event not found" } as const;
const reservedCancelReason = {
  error:
    "That cancellation reason is reserved for schedule changes. Describe this cancellation in your own words.",
  code: "reserved_cancellation_reason",
} as const;

interface SeriesRow {
  id: string;
  teamId: string;
  seasonId: string;
  title: string;
  kind: string;
  location: string | null;
  notes: string | null;
  timeZone: string;
  localTime: string;
  durationMinutes: number;
  frequency: string;
  byWeekday: string | null;
  startDate: string;
  untilDate: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface OccurrenceRow {
  id: string;
  seriesId: string;
  teamId: string;
  localDate: string;
  startsAtUtc: string;
  durationMinutes: number;
  status: string;
  cancelledReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function projectEventSeries(row: SeriesRow) {
  return eventSeriesSchema.parse({
    id: row.id,
    teamId: row.teamId,
    seasonId: row.seasonId,
    title: row.title,
    kind: row.kind,
    ...(row.location === null ? {} : { location: row.location }),
    ...(row.notes === null ? {} : { notes: row.notes }),
    timeZone: row.timeZone,
    localTime: row.localTime,
    durationMinutes: row.durationMinutes,
    frequency: row.frequency,
    ...(row.byWeekday === null ? {} : { byWeekday: JSON.parse(row.byWeekday) as unknown }),
    startDate: row.startDate,
    ...(row.untilDate === null ? {} : { untilDate: row.untilDate }),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// Deliberately drops `teamId` (the caller addressed the team), `cancelledAt`
// (updatedAt tracks it), and carries the derived instant as `startsAt`.
export function projectEventOccurrence(row: OccurrenceRow) {
  return eventOccurrenceSchema.parse({
    id: row.id,
    seriesId: row.seriesId,
    localDate: row.localDate,
    startsAt: row.startsAtUtc,
    durationMinutes: row.durationMinutes,
    status: row.status,
    ...(row.cancelledReason === null ? {} : { cancelledReason: row.cancelledReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

type ScheduleRejection =
  | { readonly code: "unknown_time_zone"; readonly error: string }
  | { readonly code: "no_occurrences"; readonly error: string }
  | { readonly code: "too_many_occurrences"; readonly error: string };

/**
 * The dates a schedule materializes, or the coded refusal the route answers as
 * a 422. Every rejection is value-free by construction — schedules carry no
 * child data, but the shape mirrors the roster import's coded refusals.
 */
export function materializableDates(
  schedule: EventSchedule,
): { ok: true; dates: string[] } | { ok: false; rejection: ScheduleRejection } {
  if (!isValidTimeZone(schedule.timeZone)) {
    return {
      ok: false,
      rejection: {
        error: "The time zone is not a known IANA zone name.",
        code: "unknown_time_zone",
      },
    };
  }

  const dates = scheduleDates(schedule, MAX_SERIES_OCCURRENCES + 1);
  if (dates.length === 0) {
    return {
      ok: false,
      rejection: {
        error:
          "This schedule names no dates: no selected weekday falls between its start and until dates.",
        code: "no_occurrences",
      },
    };
  }
  if (dates.length > MAX_SERIES_OCCURRENCES) {
    return {
      ok: false,
      rejection: {
        error: `This schedule names more than the ${MAX_SERIES_OCCURRENCES} occurrences one series may hold. Shorten the date range.`,
        code: "too_many_occurrences",
      },
    };
  }

  return { ok: true, dates };
}

function scheduleColumns(schedule: EventSchedule) {
  return {
    timeZone: schedule.timeZone,
    localTime: schedule.localTime,
    durationMinutes: schedule.durationMinutes,
    frequency: schedule.frequency,
    byWeekday: schedule.byWeekday === undefined ? null : JSON.stringify(schedule.byWeekday),
    startDate: schedule.startDate,
    untilDate: schedule.untilDate ?? null,
  };
}

async function insertOccurrence(
  tx: Db,
  series: { id: string; teamId: string },
  schedule: EventSchedule,
  localDate: string,
  now: string,
) {
  return tx
    .insert(eventOccurrences)
    .values({
      id: `event_occurrence_${crypto.randomUUID()}`,
      seriesId: series.id,
      teamId: series.teamId,
      localDate,
      startsAtUtc: instantFromWallTime(localDate, schedule.localTime, schedule.timeZone),
      durationMinutes: schedule.durationMinutes,
      status: "scheduled",
      cancelledReason: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Every occurrence of one series, ascending by date — the one read order. */
export async function seriesOccurrenceRows(tx: Db, seriesId: string): Promise<OccurrenceRow[]> {
  const rows = await tx
    .select()
    .from(eventOccurrences)
    .where(eq(eventOccurrences.seriesId, seriesId))
    .all();
  rows.sort(
    (left, right) =>
      left.localDate.localeCompare(right.localDate) || left.id.localeCompare(right.id),
  );
  return rows;
}

const operationError = <C extends string>(
  status: 400 | 401 | 404 | 409 | 422,
  code: C,
  error: string,
): CoordinationResult<never> => ({ ok: false, status, body: { error, code } });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalEventInput(input: CreateEventInput): string {
  return JSON.stringify({
    title: input.title,
    kind: input.kind,
    location: input.location ?? null,
    notes: input.notes ?? null,
    schedule: {
      timeZone: input.schedule.timeZone,
      localTime: input.schedule.localTime,
      durationMinutes: input.schedule.durationMinutes,
      frequency: input.schedule.frequency,
      byWeekday: input.schedule.byWeekday ?? null,
      startDate: input.schedule.startDate,
      untilDate: input.schedule.untilDate ?? null,
    },
    snackDuty:
      input.snackDuty === undefined
        ? null
        : {
            label: input.snackDuty.label,
            instructions: input.snackDuty.instructions ?? null,
          },
  });
}

async function eventCreationReceipt(
  tx: Db,
  actor: ApplicationActor,
  target: { teamId: string; seasonId: string },
  requestId: string,
) {
  return tx
    .select()
    .from(eventCreationReceipts)
    .where(
      and(
        eq(eventCreationReceipts.actorAccountId, actor.accountId),
        eq(eventCreationReceipts.teamId, target.teamId),
        eq(eventCreationReceipts.seasonId, target.seasonId),
        eq(eventCreationReceipts.requestId, requestId),
      ),
    )
    .get();
}

async function createdEventResponse(
  tx: Db,
  actor: ApplicationActor,
  receipt: NonNullable<Awaited<ReturnType<typeof eventCreationReceipt>>>,
) {
  const resolved = await activeSeriesForOperation(tx, actor.personId, "team.operations.manage", {
    teamId: receipt.teamId,
    seriesId: receipt.seriesId,
  });
  if (resolved === undefined || resolved.series.seasonId !== receipt.seasonId) return;

  const occurrences = await seriesOccurrenceRows(tx, resolved.series.id);
  const duty =
    receipt.dutySlotId === null
      ? undefined
      : await projectedDutySlot(tx, receipt.teamId, undefined, receipt.dutySlotId);
  if (
    receipt.dutySlotId !== null &&
    (duty === undefined || !occurrences.some((occurrence) => occurrence.id === duty.occurrenceId))
  ) {
    throw new Error("Event creation receipt refers to a missing duty slot.");
  }

  return createEventResponseSchema.parse({
    series: projectEventSeries(resolved.series),
    occurrences: occurrences.map(projectEventOccurrence),
    dutySlots: duty === undefined ? [] : [duty],
  });
}

export function createEventOperations(
  services: CoordinationServices,
): Pick<CoordinationOperations, "createEvent" | "listSeasonEvents"> {
  return {
    async createEvent(candidateActor, command) {
      const parsed = createEventCommandSchema.safeParse(command);
      if (!parsed.success) {
        return operationError(400, "invalid_request", "request body is invalid");
      }

      const { teamId, seasonId, input } = parsed.data;
      const materialized = materializableDates(input.schedule);
      if (!materialized.ok) {
        return operationError(422, materialized.rejection.code, materialized.rejection.error);
      }
      const requestHash =
        input.requestId === undefined ? undefined : await sha256(canonicalEventInput(input));

      return services.db.transaction(async (tx) => {
        const actor = await activeApplicationActor(tx, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const team = await manageableActiveTeam(tx, teamId, actor.personId);
        if (team === undefined) return operationError(404, "team_not_found", "team not found");
        const season = await activeSeasonForOperation(
          tx,
          actor.personId,
          "team.operations.manage",
          { teamId, seasonId },
        );
        if (season === undefined) return operationError(404, "team_not_found", "team not found");

        if (input.requestId !== undefined) {
          const receipt = await eventCreationReceipt(
            tx,
            actor,
            { teamId: team.id, seasonId: season.id },
            input.requestId,
          );
          if (receipt !== undefined) {
            if (receipt.actorPersonId !== actor.personId || receipt.requestHash !== requestHash) {
              return operationError(
                409,
                "request_id_conflict",
                "requestId was already used for a different event",
              );
            }
            const response = await createdEventResponse(tx, actor, receipt);
            if (response === undefined) {
              return operationError(404, "event_not_found", "event not found");
            }
            return { ok: true, value: response };
          }
        }

        const now = new Date(services.clock()).toISOString();
        if (input.snackDuty !== undefined) {
          const localDate = materialized.dates[0];
          if (
            localDate === undefined ||
            instantFromWallTime(localDate, input.schedule.localTime, input.schedule.timeZone) <= now
          ) {
            return operationError(
              409,
              "event_occurrence_unavailable",
              "event occurrence is not available for duty assignment",
            );
          }
        }
        const row = await tx
          .insert(eventSeries)
          .values({
            id: `event_series_${crypto.randomUUID()}`,
            teamId: team.id,
            seasonId: season.id,
            title: input.title,
            kind: input.kind,
            location: input.location ?? null,
            notes: input.notes ?? null,
            ...scheduleColumns(input.schedule),
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const occurrenceRows = [];
        for (const localDate of materialized.dates) {
          occurrenceRows.push(await insertOccurrence(tx, row, input.schedule, localDate, now));
        }

        let duty;
        if (input.snackDuty !== undefined) {
          const occurrence = occurrenceRows[0];
          if (occurrence === undefined) throw new Error("Single event did not materialize.");
          duty = await insertDutySlot(tx, {
            teamId: team.id,
            occurrenceId: occurrence.id,
            input: input.snackDuty,
            actorPersonId: actor.personId,
            now,
          });
        }

        if (input.requestId !== undefined && requestHash !== undefined) {
          await tx
            .insert(eventCreationReceipts)
            .values({
              id: `event_creation_receipt_${crypto.randomUUID()}`,
              actorAccountId: actor.accountId,
              actorPersonId: actor.personId,
              teamId: team.id,
              seasonId: season.id,
              requestId: input.requestId,
              requestHash,
              seriesId: row.id,
              dutySlotId: duty?.id ?? null,
              createdAt: now,
            })
            .run();
        }

        return {
          ok: true,
          value: createEventResponseSchema.parse({
            series: projectEventSeries(row),
            occurrences: occurrenceRows.map(projectEventOccurrence),
            dutySlots:
              duty === undefined
                ? []
                : [await projectedDutySlot(tx, team.id, duty.occurrenceId, duty.id)],
          }),
        };
      });
    },

    async listSeasonEvents(candidateActor, targetInput) {
      const target = seasonTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      return services.db.transaction(async (tx) => {
        const actor = await activeApplicationActor(tx, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const team = await readableActiveTeam(tx, target.data.teamId, actor.personId);
        if (team === undefined) return operationError(404, "team_not_found", "team not found");
        const season = await activeSeasonForOperation(
          tx,
          actor.personId,
          "season.read",
          target.data,
        );
        if (season === undefined) return operationError(404, "team_not_found", "team not found");
        return {
          ok: true,
          value: seasonEventsResponseSchema.parse({
            events: await loadSeasonEvents(tx, team.id, season.id),
          }),
        };
      });
    },
  };
}

async function createSeries(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/events">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(createEventInputSchema);
  const outcome = await createEventOperations({ db, clock }).createEvent(
    { accountId: identity.account.id, personId: identity.person.id },
    { teamId: c.param("teamId"), seasonId: c.param("seasonId"), input },
  );
  if (!outcome.ok) {
    const body = ["authentication_required", "team_not_found", "event_not_found"].includes(
      outcome.body.code,
    )
      ? { error: outcome.body.error }
      : outcome.body;
    return c.json(body, outcome.status);
  }
  return c.json(outcome.value, 201);
}

/**
 * Whether a kept date's existing row comes back from a cancel. Only OUR
 * machine cancel is reversible, and only while the occurrence is still ahead
 * of us, so a human "field flooded" and everything already past survive an edit
 * untouched.
 *
 * The instant the row is moving TO decides, not the one it is moving from: the
 * same edit may change `localTime` or the zone, and reinstating on the stale
 * value would either mark a now-past occurrence `scheduled` or strand a
 * now-future one cancelled with a reason that is no longer true.
 */
function reinstatesOnReturn(row: OccurrenceRow, startsAtUtc: string, now: string): boolean {
  return (
    row.status === "cancelled" &&
    row.cancelledReason === RESCHEDULE_CANCEL_REASON &&
    startsAtUtc > now
  );
}

/**
 * The schedule-edit reconcile, keyed by local date (ADR 0009): kept dates keep
 * their row (attendance and cancellation state included) with time fields
 * recomputed; new dates gain a row; a FUTURE date the new schedule dropped is
 * cancelled with the reserved reason; past occurrences of dropped dates are
 * left exactly as history recorded them.
 *
 * A kept date whose row was cancelled BY A PREVIOUS EDIT is reinstated, so
 * drop-then-restore returns the series to where it started instead of stranding
 * cancelled rows the unique `(series_id, local_date)` index forbids replacing.
 */
async function reconcileOccurrences(
  tx: Db,
  series: { id: string; teamId: string },
  schedule: EventSchedule,
  dates: readonly string[],
  now: string,
): Promise<void> {
  const existing = await seriesOccurrenceRows(tx, series.id);
  const existingByDate = new Map(existing.map((row) => [row.localDate, row] as const));
  const kept = new Set(dates);

  for (const localDate of dates) {
    const row = existingByDate.get(localDate);
    if (row === undefined) {
      await insertOccurrence(tx, series, schedule, localDate, now);
      continue;
    }
    const startsAtUtc = instantFromWallTime(localDate, schedule.localTime, schedule.timeZone);
    const reinstate = reinstatesOnReturn(row, startsAtUtc, now);
    await tx
      .update(eventOccurrences)
      .set({
        startsAtUtc,
        durationMinutes: schedule.durationMinutes,
        ...(reinstate ? { status: "scheduled", cancelledReason: null, cancelledAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(eventOccurrences.id, row.id))
      .run();
  }

  for (const row of existing) {
    if (kept.has(row.localDate)) continue;
    if (row.status === "cancelled") continue;
    if (row.startsAtUtc <= now) continue;

    await tx
      .update(eventOccurrences)
      .set({
        status: "cancelled",
        cancelledReason: RESCHEDULE_CANCEL_REASON,
        cancelledAt: now,
        updatedAt: now,
      })
      .where(eq(eventOccurrences.id, row.id))
      .run();
  }
}

async function updateSeries(
  c: Context<"/api/teams/:teamId/events/:seriesId/update">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(eventSeriesInputSchema);
  const materialized = materializableDates(input.schedule);
  if (!materialized.ok) return c.json(materialized.rejection, 422);

  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const resolved = await activeSeriesForOperation(
      tx,
      identity.person.id,
      "team.operations.manage",
      { teamId: team.id, seriesId: c.param("seriesId") },
    );
    if (resolved === undefined) return "no-series" as const;
    const row = resolved.series;

    const now = new Date(clock()).toISOString();
    await tx
      .update(eventSeries)
      .set({
        title: input.title,
        kind: input.kind,
        location: input.location ?? null,
        notes: input.notes ?? null,
        ...scheduleColumns(input.schedule),
        updatedAt: now,
      })
      .where(eq(eventSeries.id, row.id))
      .run();
    await reconcileOccurrences(tx, row, input.schedule, materialized.dates, now);

    const updated = await tx.select().from(eventSeries).where(eq(eventSeries.id, row.id)).get();
    if (updated === undefined) throw new Error("Event series disappeared during update.");

    return { series: updated, occurrences: await seriesOccurrenceRows(tx, row.id) };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-series") return c.json(eventNotFound, 404);

  return c.json({
    series: projectEventSeries(outcome.series),
    occurrences: outcome.occurrences.map((row) => projectEventOccurrence(row)),
  });
}

async function cancelOccurrence(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/cancel">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(cancelOccurrenceInputSchema);
  // A human who typed the reconcile's machine-cancel marker would have their
  // cancellation undone by the next edit; the marker is not theirs to write.
  if (input.reason === RESCHEDULE_CANCEL_REASON) return c.json(reservedCancelReason, 422);

  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const resolved = await activeOccurrenceForOperation(
      tx,
      identity.person.id,
      "team.operations.manage",
      { teamId: team.id, occurrenceId: c.param("occurrenceId") },
    );
    if (resolved === undefined) return "no-occurrence" as const;
    const row = resolved.occurrence;
    // Cancelling an already-cancelled occurrence is an idempotent no-op that
    // PRESERVES a human's original reason: the caller's intent ("this must not
    // happen") already holds, and history is not rewritten. OUR marker is the
    // exception — it is a machine annotation, not history, and leaving it in
    // place would let the next schedule edit reinstate an occurrence a human
    // has now explicitly cancelled.
    if (row.status === "cancelled" && row.cancelledReason !== RESCHEDULE_CANCEL_REASON) {
      return { row };
    }

    const now = new Date(clock()).toISOString();
    await tx
      .update(eventOccurrences)
      .set({ status: "cancelled", cancelledReason: input.reason, cancelledAt: now, updatedAt: now })
      .where(eq(eventOccurrences.id, row.id))
      .run();
    const cancelled = await tx
      .select()
      .from(eventOccurrences)
      .where(eq(eventOccurrences.id, row.id))
      .get();
    if (cancelled === undefined) throw new Error("Event occurrence disappeared during cancel.");

    return { row: cancelled };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);

  return c.json({ occurrence: projectEventOccurrence(outcome.row) });
}

/** Attendance folded to counts — the only attendance shape every reader gets. */
export interface AttendanceCounts {
  yes: number;
  no: number;
  maybe: number;
}

export function emptyAttendanceCounts(): AttendanceCounts {
  return { yes: 0, no: 0, maybe: 0 };
}

export async function attendanceCountsByOccurrence(
  db: Db,
  occurrenceIds: readonly string[],
): Promise<Map<string, AttendanceCounts>> {
  const counts = new Map<string, AttendanceCounts>(
    occurrenceIds.map((occurrenceId) => [occurrenceId, emptyAttendanceCounts()] as const),
  );
  if (occurrenceIds.length === 0) return counts;

  const rows = await db
    .select()
    .from(eventAttendance)
    .where(inList(eventAttendance.occurrenceId, [...occurrenceIds]))
    .all();
  for (const row of rows) {
    const bucket = counts.get(row.occurrenceId);
    if (bucket === undefined) continue;
    if (row.status === "yes") bucket.yes += 1;
    else if (row.status === "no") bucket.no += 1;
    else if (row.status === "maybe") bucket.maybe += 1;
  }

  return counts;
}

/**
 * The one events projection: every ACTIVE series on the team with its
 * occurrences (cancelled ones included — they are history, not absence) and
 * per-occurrence attendance COUNTS. Each distinct season is resolved through
 * the canonical policy. A caller's team selection is never authority.
 */
export async function loadTeamEvents(db: Db, teamId: string, personId: string) {
  const candidateSeriesRows = await db
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.teamId, teamId), eq(eventSeries.status, "active")))
    .all();
  const readableSeason = new Map<string, boolean>();
  const seriesRows = [];
  for (const row of candidateSeriesRows) {
    let allowed = readableSeason.get(row.seasonId);
    if (allowed === undefined) {
      allowed =
        (await activeSeasonForOperation(db, personId, "season.read", {
          teamId,
          seasonId: row.seasonId,
        })) !== undefined;
      readableSeason.set(row.seasonId, allowed);
    }
    if (allowed) seriesRows.push(row);
  }
  seriesRows.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
  );
  if (seriesRows.length === 0) return [];

  const occurrenceRows = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.teamId, teamId),
        inList(
          eventOccurrences.seriesId,
          seriesRows.map((row) => row.id),
        ),
      ),
    )
    .all();
  occurrenceRows.sort(
    (left, right) =>
      left.localDate.localeCompare(right.localDate) || left.id.localeCompare(right.id),
  );
  const counts = await attendanceCountsByOccurrence(
    db,
    occurrenceRows.map((row) => row.id),
  );

  return seriesRows.map((row) => ({
    series: projectEventSeries(row),
    occurrences: occurrenceRows
      .filter((occurrence) => occurrence.seriesId === row.id)
      .map((occurrence) => ({
        ...projectEventOccurrence(occurrence),
        attendance: counts.get(occurrence.id) ?? emptyAttendanceCounts(),
      })),
  }));
}

/** The selected-season projection used by native coordination. */
export async function loadSeasonEvents(db: Db, teamId: string, seasonId: string) {
  const seriesRows = await db
    .select()
    .from(eventSeries)
    .where(
      and(
        eq(eventSeries.teamId, teamId),
        eq(eventSeries.seasonId, seasonId),
        eq(eventSeries.status, "active"),
      ),
    )
    .all();
  seriesRows.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
  );
  if (seriesRows.length === 0) return [];

  const occurrenceRows = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(
        eq(eventOccurrences.teamId, teamId),
        inList(
          eventOccurrences.seriesId,
          seriesRows.map((row) => row.id),
        ),
      ),
    )
    .all();
  occurrenceRows.sort(
    (left, right) =>
      left.localDate.localeCompare(right.localDate) || left.id.localeCompare(right.id),
  );
  const counts = await attendanceCountsByOccurrence(
    db,
    occurrenceRows.map((row) => row.id),
  );

  return seriesRows.map((row) => ({
    series: projectEventSeries(row),
    occurrences: occurrenceRows
      .filter((occurrence) => occurrence.seriesId === row.id)
      .map((occurrence) => ({
        ...projectEventOccurrence(occurrence),
        attendance: counts.get(occurrence.id) ?? emptyAttendanceCounts(),
      })),
  }));
}

async function listTeamEvents(c: Context<"/api/teams/:teamId/events">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const events = await db.transaction(async (tx) => {
    const team = await readableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;
    return loadTeamEvents(tx, team.id, identity.person.id);
  });
  if (events === null) return c.json(teamNotFound, 404);

  return c.json({ events });
}

async function listSelectedSeasonEvents(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/events">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await createEventOperations({ db, clock }).listSeasonEvents(
    { accountId: identity.account.id, personId: identity.person.id },
    { teamId: c.param("teamId"), seasonId: c.param("seasonId") },
  );
  if (!outcome.ok) return c.json({ error: outcome.body.error }, outcome.status);
  return c.json(outcome.value);
}

export function registerEventRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  clock: Clock = Date.now,
) {
  return app
    .post("/api/teams/:teamId/seasons/:seasonId/events", (c) =>
      createSeries(c, db, sessions, clock),
    )
    .get("/api/teams/:teamId/seasons/:seasonId/events", (c) =>
      listSelectedSeasonEvents(c, db, sessions, clock),
    )
    .post("/api/teams/:teamId/events/:seriesId/update", (c) => updateSeries(c, db, sessions, clock))
    .post("/api/teams/:teamId/occurrences/:occurrenceId/cancel", (c) =>
      cancelOccurrence(c, db, sessions, clock),
    )
    .get("/api/teams/:teamId/events", (c) => listTeamEvents(c, db, sessions));
}
