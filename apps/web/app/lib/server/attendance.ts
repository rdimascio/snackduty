import type { Clock } from "./application-contracts";
/**
 * Per-child attendance on one occurrence, under the guardian rule (ADR 0009).
 *
 * WRITE: a manager records attendance for any child rostered on the series'
 * season; a guardian records it for children they hold an ACTIVE
 * `guardian_relationships` edge to. Every other combination — a stranger, a
 * read-only adult with no edge to this child, an unknown child — answers the
 * SAME hiding 404 an unknown participant gets, never a 403: whether a child
 * exists on a roster is exactly the kind of fact the 404 protects.
 *
 * READ: attendance is a per-child fact about a minor, so the default is the
 * narrow one — a manager reads every child's entries, a guardian reads their
 * own children's, and every other team reader gets COUNTS only. Widening that
 * (e.g. all team adults see who is coming) is an operator decision, not a
 * default.
 */

import type { SessionService as Sessions } from "./application-contracts";
import { and, eq, inList } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { attendanceRecordSchema } from "@snackday/domain";

import {
  attendanceCountsByOccurrence,
  emptyAttendanceCounts,
  eventAttendance,
  recordAttendanceInputSchema,
} from "./events";
import { authenticatedAdult, people } from "./identity";
import { authorizeTeamOperation } from "./authorization";
import { activeOccurrenceForOperation } from "./occurrence-access";
import { memberships, participants } from "./roster";
import { teamAccess } from "./teams";

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const eventNotFound = { error: "event not found" } as const;
const participantNotFound = { error: "participant not found" } as const;
const occurrenceCancelled = { error: "event occurrence is cancelled" } as const;

/** Whether this child is ACTIVE on the season's roster the series belongs to. */
async function rosteredParticipant(
  tx: Db,
  target: { teamId: string; seasonId: string },
  participantId: string,
) {
  const participant = await tx
    .select()
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.status, "active")))
    .get();
  if (participant === undefined) return undefined;

  const membership = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.teamId, target.teamId),
        eq(memberships.seasonId, target.seasonId),
        eq(memberships.memberParticipantId, participant.id),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .get();

  return membership === undefined ? undefined : participant;
}

function projectAttendance(row: {
  id: string;
  occurrenceId: string;
  participantId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}) {
  const record = attendanceRecordSchema.parse({
    id: row.id,
    occurrenceId: row.occurrenceId,
    participantId: row.participantId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  // The recording adult's person id never leaves the row; the record id adds
  // nothing a caller can act on either.
  return { participantId: record.participantId, status: record.status };
}

async function recordAttendance(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/attendance">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(recordAttendanceInputSchema);
  const outcome = await db.transaction(async (tx) => {
    const access = await teamAccess(tx, c.param("teamId"), identity.person.id);
    if (access === undefined) return null;

    const found = await activeOccurrenceForOperation(tx, identity.person.id, "season.read", {
      teamId: access.team.id,
      occurrenceId: c.param("occurrenceId"),
    });
    if (found === undefined) return "no-occurrence" as const;
    if (found.occurrence.status === "cancelled") return "cancelled" as const;

    const participant = await rosteredParticipant(
      tx,
      { teamId: access.team.id, seasonId: found.series.seasonId },
      input.participantId,
    );
    if (participant === undefined) return "no-participant" as const;

    if (
      !(await authorizeTeamOperation(tx, identity.person.id, "participant.manage", {
        teamId: access.team.id,
        seasonId: found.series.seasonId,
        participantId: participant.id,
      }))
    )
      return "no-participant" as const;

    const now = new Date(clock()).toISOString();
    const existing = await tx
      .select()
      .from(eventAttendance)
      .where(
        and(
          eq(eventAttendance.occurrenceId, found.occurrence.id),
          eq(eventAttendance.participantId, participant.id),
        ),
      )
      .get();
    if (existing === undefined) {
      const inserted = await tx
        .insert(eventAttendance)
        .values({
          id: `attendance_${crypto.randomUUID()}`,
          occurrenceId: found.occurrence.id,
          participantId: participant.id,
          status: input.status,
          recordedByPersonId: identity.person.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      return { row: inserted };
    }

    await tx
      .update(eventAttendance)
      .set({ status: input.status, recordedByPersonId: identity.person.id, updatedAt: now })
      .where(eq(eventAttendance.id, existing.id))
      .run();
    const updated = await tx
      .select()
      .from(eventAttendance)
      .where(eq(eventAttendance.id, existing.id))
      .get();
    if (updated === undefined) throw new Error("Attendance record disappeared during update.");

    return { row: updated };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  if (outcome === "cancelled") return c.json(occurrenceCancelled, 409);
  if (outcome === "no-participant") return c.json(participantNotFound, 404);

  return c.json({ attendance: projectAttendance(outcome.row) });
}

async function readAttendance(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/attendance">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const access = await teamAccess(tx, c.param("teamId"), identity.person.id);
    if (access === undefined) return null;

    const found = await activeOccurrenceForOperation(tx, identity.person.id, "season.read", {
      teamId: access.team.id,
      occurrenceId: c.param("occurrenceId"),
    });
    if (found === undefined) return "no-occurrence" as const;

    const rows = await tx
      .select()
      .from(eventAttendance)
      .where(eq(eventAttendance.occurrenceId, found.occurrence.id))
      .all();
    const counts =
      (await attendanceCountsByOccurrence(tx, [found.occurrence.id])).get(found.occurrence.id) ??
      emptyAttendanceCounts();

    const entries = [];
    for (const row of rows) {
      if (
        await authorizeTeamOperation(tx, identity.person.id, "participant.read", {
          teamId: access.team.id,
          seasonId: found.series.seasonId,
          participantId: row.participantId,
        })
      )
        entries.push(row);
    }

    const participantRows =
      entries.length === 0
        ? []
        : await tx
            .select()
            .from(participants)
            .where(
              inList(
                participants.id,
                entries.map((row) => row.participantId),
              ),
            )
            .all();
    const personRows =
      participantRows.length === 0
        ? []
        : await tx
            .select()
            .from(people)
            .where(
              inList(
                people.id,
                participantRows.map((row) => row.personId),
              ),
            )
            .all();
    const namesByParticipantId = new Map(
      participantRows.map((row) => {
        const person = personRows.find((candidate) => candidate.id === row.personId);
        return [row.id, person?.displayName ?? ""] as const;
      }),
    );

    const projected = entries.map((row) => ({
      ...projectAttendance(row),
      displayName: namesByParticipantId.get(row.participantId) ?? "",
    }));
    projected.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.participantId.localeCompare(right.participantId),
    );

    return { counts, entries: projected };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  return c.json({ attendance: outcome });
}

export function registerAttendanceRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  clock: Clock = Date.now,
) {
  return app
    .post("/api/teams/:teamId/occurrences/:occurrenceId/attendance", (c) =>
      recordAttendance(c, db, sessions, clock),
    )
    .get("/api/teams/:teamId/occurrences/:occurrenceId/attendance", (c) =>
      readAttendance(c, db, sessions),
    );
}
