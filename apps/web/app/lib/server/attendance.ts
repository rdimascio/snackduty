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
import { and, eq, inList, rawChanges } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import {
  attendanceInputSchema,
  attendanceReadResponseSchema,
  attendanceRecordSchema,
  attendanceResponseSchema,
} from "@snackday/domain";
import { z } from "zod";

import { activeApplicationActor } from "./coordination-actor";
import type {
  CoordinationOperations,
  CoordinationResult,
  CoordinationServices,
} from "./coordination-contracts";
import { countAttendance, eventAttendance } from "./events";
import { authenticatedAdult, people } from "./identity";
import { authorizedTeamOperationProof, authorizeTeamOperation, proofGuard } from "./authorization";
import type { SqlGuard } from "./authorization";
import { activeOccurrenceForOperation, eventOccurrences } from "./occurrence-access";
import { memberships, participants } from "./roster";
import { teamAccess } from "./teams";

const unauthorized = { error: "authentication required" } as const;
const occurrenceTargetSchema = z.strictObject({
  teamId: z.string().trim().min(1),
  occurrenceId: z.string().trim().min(1),
});
const attendanceCommandSchema = occurrenceTargetSchema.extend({ input: attendanceInputSchema });

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

const CANCELLED = "cancelled";

function guardedAttendanceUpsert(command: {
  readonly occurrenceId: string;
  readonly roster: { readonly teamId: string; readonly seasonId: string };
  readonly participantId: string;
  readonly status: string;
  readonly recordedByPersonId: string;
  readonly now: string;
  readonly proof: SqlGuard;
}) {
  return rawChanges(
    `INSERT INTO event_attendance (id, occurrence_id, participant_id, status, recorded_by_person_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM event_occurrences WHERE event_occurrences.id = ? AND event_occurrences.status <> ?) AND EXISTS (SELECT 1 FROM memberships JOIN participants ON participants.id = memberships.member_participant_id WHERE memberships.team_id = ? AND memberships.season_id = ? AND memberships.member_kind = ? AND memberships.status = ? AND participants.id = ? AND participants.status = ?) AND ${command.proof.sql} ON CONFLICT (occurrence_id, participant_id) DO UPDATE SET status = excluded.status, recorded_by_person_id = excluded.recorded_by_person_id, updated_at = excluded.updated_at`,
    [
      `attendance_${crypto.randomUUID()}`,
      command.occurrenceId,
      command.participantId,
      command.status,
      command.recordedByPersonId,
      command.now,
      command.now,
      command.occurrenceId,
      CANCELLED,
      command.roster.teamId,
      command.roster.seasonId,
      "participant",
      "active",
      command.participantId,
      "active",
      ...command.proof.params,
    ],
  );
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

const operationError = <C extends string>(
  status: 400 | 401 | 404 | 409 | 422,
  code: C,
  error: string,
): Extract<CoordinationResult<never>, { ok: false }> => ({
  ok: false,
  status,
  body: { error, code },
});

async function participantNames(
  tx: Db,
  participantRows: readonly { id: string; personId: string }[],
) {
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
  const peopleById = new Map(personRows.map((person) => [person.id, person] as const));
  return new Map(
    participantRows.map((participant) => [
      participant.id,
      peopleById.get(participant.personId)?.displayName ?? "",
    ]),
  );
}

export function createAttendanceOperations(
  services: CoordinationServices,
): Pick<CoordinationOperations, "readAttendance" | "recordAttendance"> {
  return {
    async recordAttendance(candidateActor, command) {
      const parsed = attendanceCommandSchema.safeParse(command);
      if (!parsed.success) {
        return operationError(400, "invalid_request", "request body is invalid");
      }
      const { teamId, occurrenceId, input } = parsed.data;

      const { db } = services;
      const authorizeOccurrence = async () => {
        const actor = await activeApplicationActor(db, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const access = await teamAccess(db, teamId, actor.personId);
        if (access === undefined) return operationError(404, "team_not_found", "team not found");
        const found = await activeOccurrenceForOperation(db, actor.personId, "season.read", {
          teamId: access.team.id,
          occurrenceId,
        });
        if (found === undefined) return operationError(404, "event_not_found", "event not found");
        return { ok: true as const, actor, access, found };
      };
      const authorized = await authorizeOccurrence();
      if (!authorized.ok) return authorized;
      const { actor, access, found } = authorized;
      const occurrenceCancelled = () =>
        operationError(409, "event_occurrence_cancelled", "event occurrence is cancelled");
      const participantNotFound = () =>
        operationError(404, "participant_not_found", "participant not found");
      if (found.occurrence.status === CANCELLED) return occurrenceCancelled();
      const roster = { teamId: access.team.id, seasonId: found.series.seasonId };
      const participant = await rosteredParticipant(db, roster, input.participantId);
      const participantProof =
        participant === undefined
          ? undefined
          : await authorizedTeamOperationProof(db, actor.personId, "participant.manage", {
              ...roster,
              participantId: input.participantId,
            });
      if (participant === undefined || participantProof === undefined) {
        return participantNotFound();
      }

      const [written] = await db.batch([
        guardedAttendanceUpsert({
          occurrenceId: found.occurrence.id,
          roster,
          participantId: participant.id,
          status: input.status,
          recordedByPersonId: actor.personId,
          now: new Date(services.clock()).toISOString(),
          proof: proofGuard(access.proof, found.proof, participantProof),
        }),
      ]);
      if (written.changes === 0) {
        const reauthorized = await authorizeOccurrence();
        if (!reauthorized.ok) return reauthorized;
        const occurrence = await db
          .select()
          .from(eventOccurrences)
          .where(eq(eventOccurrences.id, found.occurrence.id))
          .get();
        if (occurrence === undefined) {
          return operationError(404, "event_not_found", "event not found");
        }
        return occurrence.status === CANCELLED ? occurrenceCancelled() : participantNotFound();
      }

      const row = await db
        .select()
        .from(eventAttendance)
        .where(
          and(
            eq(eventAttendance.occurrenceId, found.occurrence.id),
            eq(eventAttendance.participantId, participant.id),
          ),
        )
        .get();
      if (row === undefined) throw new Error("Attendance record disappeared after write.");
      return {
        ok: true,
        value: attendanceResponseSchema.parse({ attendance: projectAttendance(row) }),
      };
    },

    async readAttendance(candidateActor, targetInput) {
      const target = occurrenceTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      const { db } = services;
      const actor = await activeApplicationActor(db, candidateActor);
      if (actor === undefined) {
        return operationError(401, "authentication_required", "authentication required");
      }
      const access = await teamAccess(db, target.data.teamId, actor.personId);
      if (access === undefined) return operationError(404, "team_not_found", "team not found");
      const found = await activeOccurrenceForOperation(db, actor.personId, "season.read", {
        teamId: access.team.id,
        occurrenceId: target.data.occurrenceId,
      });
      if (found === undefined) return operationError(404, "event_not_found", "event not found");

      const rows = await db
        .select()
        .from(eventAttendance)
        .where(eq(eventAttendance.occurrenceId, found.occurrence.id))
        .all();
      const counts = countAttendance(rows);
      const readableRows = [];
      for (const row of rows) {
        if (
          await authorizeTeamOperation(db, actor.personId, "participant.read", {
            teamId: access.team.id,
            seasonId: found.series.seasonId,
            participantId: row.participantId,
          })
        ) {
          readableRows.push(row);
        }
      }

      const rosterMemberships = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.teamId, access.team.id),
            eq(memberships.seasonId, found.series.seasonId),
            eq(memberships.memberKind, "participant"),
            eq(memberships.status, "active"),
          ),
        )
        .all();
      const rosterIds = [
        ...new Set(
          rosterMemberships.flatMap((membership) =>
            membership.memberParticipantId === null ? [] : [membership.memberParticipantId],
          ),
        ),
      ];
      const rosterParticipants =
        rosterIds.length === 0
          ? []
          : await db
              .select()
              .from(participants)
              .where(and(inList(participants.id, rosterIds), eq(participants.status, "active")))
              .all();
      const manageableParticipants = [];
      for (const participant of rosterParticipants) {
        if (
          await authorizeTeamOperation(db, actor.personId, "participant.manage", {
            teamId: access.team.id,
            seasonId: found.series.seasonId,
            participantId: participant.id,
          })
        ) {
          manageableParticipants.push(participant);
        }
      }

      const allParticipants = new Map(
        [
          ...readableRows.map((row) => row.participantId),
          ...manageableParticipants.map((row) => row.id),
        ]
          .map((id) => [id, rosterParticipants.find((participant) => participant.id === id)])
          .filter(
            (entry): entry is [string, (typeof rosterParticipants)[number]] =>
              entry[1] !== undefined,
          ),
      );
      const names = await participantNames(db, [...allParticipants.values()]);
      const entries = readableRows
        .map((row) => ({
          ...projectAttendance(row),
          displayName: names.get(row.participantId) ?? "",
        }))
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) ||
            left.participantId.localeCompare(right.participantId),
        );
      const statusByParticipant = new Map(rows.map((row) => [row.participantId, row.status]));
      const responseOptions = manageableParticipants
        .map((participant) => ({
          participantId: participant.id,
          displayName: names.get(participant.id) ?? "",
          ...(statusByParticipant.get(participant.id) === undefined
            ? {}
            : { status: statusByParticipant.get(participant.id) }),
        }))
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) ||
            left.participantId.localeCompare(right.participantId),
        );

      return {
        ok: true,
        value: attendanceReadResponseSchema.parse({
          attendance: { counts, entries, responseOptions },
        }),
      };
    },
  };
}

async function recordAttendance(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/attendance">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(attendanceInputSchema);
  const outcome = await createAttendanceOperations({ db, clock }).recordAttendance(
    { accountId: identity.account.id, personId: identity.person.id },
    { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId"), input },
  );
  if (!outcome.ok) {
    const body = [
      "authentication_required",
      "team_not_found",
      "event_not_found",
      "participant_not_found",
      "event_occurrence_cancelled",
    ].includes(outcome.body.code)
      ? { error: outcome.body.error }
      : outcome.body;
    return c.json(body, outcome.status);
  }
  return c.json(outcome.value);
}

async function readAttendance(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/attendance">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await createAttendanceOperations({ db, clock }).readAttendance(
    { accountId: identity.account.id, personId: identity.person.id },
    { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId") },
  );
  if (!outcome.ok) return c.json({ error: outcome.body.error }, outcome.status);
  return c.json(outcome.value);
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
      readAttendance(c, db, sessions, clock),
    );
}
