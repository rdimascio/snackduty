import type { Clock } from "./application-contracts";
/**
 * One-adult duty slots attached to materialized event occurrences.
 *
 * A slot is its own durable unit of capacity: one nullable adult assignee on
 * one row. Claims use a conditional `assignee IS NULL` update, so two adults
 * racing for the same slot cannot both succeed. The winning assignment and
 * every release/manager edit commit before the handler responds; this slice
 * deliberately emits no email, push, or queued side effect without a durable
 * outbox to make delivery retryable.
 *
 * Duty authority is adult-to-team authority. A caller never supplies a child,
 * participant, household, or guardian relationship to claim their own slot.
 */

import {
  and,
  createTableSql,
  defineTable,
  dropTableSql,
  eq,
  inList,
  isNull,
  text,
} from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { z } from "zod";

import type { SessionService as Sessions } from "./application-contracts";
import { eventOccurrences } from "./events";
import { accounts, authenticatedAdult, people } from "./identity";
import { manageableActiveTeam, readableActiveTeam, teamAccess, teams } from "./teams";

export const dutySlots = defineTable("duty_slots", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  occurrenceId: text("occurrence_id")
    .notNull()
    .references(() => eventOccurrences.id),
  label: text("label").notNull(),
  instructions: text("instructions"),
  assigneePersonId: text("assignee_person_id").references(() => people.id),
  assignedByPersonId: text("assigned_by_person_id").references(() => people.id),
  assignedAt: text("assigned_at"),
  createdByPersonId: text("created_by_person_id")
    .notNull()
    .references(() => people.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createDuties: MigrationEntry = {
  version: "009_create_duty_slots",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(dutySlots));
      schema.execute(
        "CREATE INDEX duty_slots_team_occurrence_idx ON duty_slots (team_id, occurrence_id)",
      );
      schema.execute(
        "CREATE INDEX duty_slots_assignee_person_id_idx ON duty_slots (assignee_person_id)",
      );
    },
    down: (schema) => {
      schema.execute(dropTableSql(dutySlots));
    },
  },
};

export const createDutySlotInputSchema = z.strictObject({
  label: z.string().trim().min(1, "Duty label is required.").max(120),
  instructions: z.string().trim().min(1).max(2_000).optional(),
});

export const assignDutySlotInputSchema = z.strictObject({
  assigneePersonId: z.string().trim().min(1).nullable(),
});

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const eventNotFound = { error: "event not found" } as const;
const dutyNotFound = { error: "duty slot not found" } as const;
const adultNotFound = { error: "team adult not found" } as const;
const occurrenceUnavailable = {
  error: "event occurrence is not available for duty assignment",
  code: "event_occurrence_unavailable",
} as const;
const dutyTaken = {
  error: "duty slot is already assigned",
  code: "duty_slot_taken",
} as const;
const dutyChanged = {
  error: "duty slot assignment changed; reload and try again",
  code: "duty_slot_changed",
} as const;

type DutySlotRow = Awaited<ReturnType<typeof dutySlotById>>;

function occurrenceByTeam(tx: Db, teamId: string, occurrenceId: string) {
  return tx
    .select()
    .from(eventOccurrences)
    .where(and(eq(eventOccurrences.id, occurrenceId), eq(eventOccurrences.teamId, teamId)))
    .get();
}

function dutySlotById(tx: Db, teamId: string, occurrenceId: string, slotId: string) {
  return tx
    .select()
    .from(dutySlots)
    .where(
      and(
        eq(dutySlots.id, slotId),
        eq(dutySlots.teamId, teamId),
        eq(dutySlots.occurrenceId, occurrenceId),
      ),
    )
    .get();
}

function occurrenceAcceptsNewAssignment(
  occurrence: {
    status: string;
    startsAtUtc: string;
  },
  clock: Clock,
): boolean {
  return (
    occurrence.status === "scheduled" && occurrence.startsAtUtc > new Date(clock()).toISOString()
  );
}

async function activeTeamAdult(tx: Db, teamId: string, personId: string) {
  const person = await tx
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.status, "active")))
    .get();
  if (person === undefined) return undefined;

  const account = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.personId, personId), eq(accounts.status, "active")))
    .get();
  if (account === undefined) return undefined;

  const access = await teamAccess(tx, teamId, personId);

  return access === undefined ? undefined : person;
}

function projectDutySlot(
  row: NonNullable<DutySlotRow>,
  assignee: { id: string; displayName: string } | undefined,
) {
  return {
    id: row.id,
    occurrenceId: row.occurrenceId,
    label: row.label,
    ...(row.instructions === null ? {} : { instructions: row.instructions }),
    ...(row.assigneePersonId === null
      ? {}
      : {
          assignee: {
            personId: row.assigneePersonId,
            displayName: assignee?.displayName ?? "",
          },
        }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function projectedDutySlot(tx: Db, row: NonNullable<DutySlotRow>) {
  const assignee =
    row.assigneePersonId === null
      ? undefined
      : await tx.select().from(people).where(eq(people.id, row.assigneePersonId)).get();
  return projectDutySlot(row, assignee);
}

async function createDutySlot(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(createDutySlotInputSchema);
  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const occurrence = await occurrenceByTeam(tx, team.id, c.param("occurrenceId"));
    if (occurrence === undefined) return "no-occurrence" as const;

    const now = new Date(clock()).toISOString();
    const row = await tx
      .insert(dutySlots)
      .values({
        id: `duty_slot_${crypto.randomUUID()}`,
        teamId: team.id,
        occurrenceId: occurrence.id,
        label: input.label,
        instructions: input.instructions ?? null,
        assigneePersonId: null,
        assignedByPersonId: null,
        assignedAt: null,
        createdByPersonId: identity.person.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return { row };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  return c.json({ dutySlot: await projectedDutySlot(db, outcome.row) }, 201);
}

async function listDutySlots(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const team = await readableActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(teamNotFound, 404);

  const occurrence = await occurrenceByTeam(db, team.id, c.param("occurrenceId"));
  if (occurrence === undefined) return c.json(eventNotFound, 404);

  const rows = await db
    .select()
    .from(dutySlots)
    .where(and(eq(dutySlots.teamId, team.id), eq(dutySlots.occurrenceId, occurrence.id)))
    .all();
  rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  const assigneeIds = [
    ...new Set(
      rows.flatMap((row) => (row.assigneePersonId === null ? [] : [row.assigneePersonId])),
    ),
  ];
  const assignees =
    assigneeIds.length === 0
      ? []
      : await db.select().from(people).where(inList(people.id, assigneeIds)).all();
  const assigneesById = new Map(assignees.map((person) => [person.id, person] as const));

  return c.json({
    dutySlots: rows.map((row) =>
      projectDutySlot(
        row,
        row.assigneePersonId === null ? undefined : assigneesById.get(row.assigneePersonId),
      ),
    ),
  });
}

async function claimDutySlot(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/claim">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await readableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const occurrence = await occurrenceByTeam(tx, team.id, c.param("occurrenceId"));
    if (occurrence === undefined) return "no-occurrence" as const;

    const slot = await dutySlotById(tx, team.id, occurrence.id, c.param("slotId"));
    if (slot === undefined) return "no-slot" as const;
    if (slot.assigneePersonId === identity.person.id) return { row: slot };
    if (slot.assigneePersonId !== null) return "taken" as const;
    if (!occurrenceAcceptsNewAssignment(occurrence, clock)) return "unavailable" as const;

    const now = new Date(clock()).toISOString();
    const claimed = await tx
      .update(dutySlots)
      .set({
        assigneePersonId: identity.person.id,
        assignedByPersonId: identity.person.id,
        assignedAt: now,
        updatedAt: now,
      })
      .where(and(eq(dutySlots.id, slot.id), isNull(dutySlots.assigneePersonId)))
      .run();
    const row = await dutySlotById(tx, team.id, occurrence.id, slot.id);
    if (row === undefined) throw new Error("Duty slot disappeared during claim.");

    // This branch matters on a database with concurrent writers: the
    // conditional update picks one winner even if both read the slot as open.
    if (claimed.changes === 0 && row.assigneePersonId !== identity.person.id) {
      return "taken" as const;
    }
    return { row };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  if (outcome === "no-slot") return c.json(dutyNotFound, 404);
  if (outcome === "unavailable") return c.json(occurrenceUnavailable, 409);
  if (outcome === "taken") return c.json(dutyTaken, 409);
  return c.json({ dutySlot: await projectedDutySlot(db, outcome.row) });
}

async function releaseDutySlot(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/release">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await readableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;
    const occurrence = await occurrenceByTeam(tx, team.id, c.param("occurrenceId"));
    if (occurrence === undefined) return "no-occurrence" as const;
    const slot = await dutySlotById(tx, team.id, occurrence.id, c.param("slotId"));
    if (slot === undefined) return "no-slot" as const;
    if (slot.assigneePersonId !== null && slot.assigneePersonId !== identity.person.id) {
      return "taken" as const;
    }
    if (slot.assigneePersonId === null) return { row: slot };
    if (!occurrenceAcceptsNewAssignment(occurrence, clock)) return "unavailable" as const;

    const now = new Date(clock()).toISOString();
    const released = await tx
      .update(dutySlots)
      .set({
        assigneePersonId: null,
        assignedByPersonId: null,
        assignedAt: null,
        updatedAt: now,
      })
      .where(and(eq(dutySlots.id, slot.id), eq(dutySlots.assigneePersonId, identity.person.id)))
      .run();
    const row = await dutySlotById(tx, team.id, occurrence.id, slot.id);
    if (row === undefined) throw new Error("Duty slot disappeared during release.");
    if (released.changes === 0 && row.assigneePersonId !== null) return "changed" as const;
    return { row };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  if (outcome === "no-slot") return c.json(dutyNotFound, 404);
  if (outcome === "taken") return c.json(dutyTaken, 409);
  if (outcome === "unavailable") return c.json(occurrenceUnavailable, 409);
  if (outcome === "changed") return c.json(dutyChanged, 409);
  return c.json({ dutySlot: await projectedDutySlot(db, outcome.row) });
}

async function assignDutySlot(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/assignment">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(assignDutySlotInputSchema);
  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;
    const occurrence = await occurrenceByTeam(tx, team.id, c.param("occurrenceId"));
    if (occurrence === undefined) return "no-occurrence" as const;
    const slot = await dutySlotById(tx, team.id, occurrence.id, c.param("slotId"));
    if (slot === undefined) return "no-slot" as const;

    if (slot.assigneePersonId === input.assigneePersonId) return { row: slot };
    if (!occurrenceAcceptsNewAssignment(occurrence, clock)) return "unavailable" as const;

    let assignee: { id: string } | undefined;
    if (input.assigneePersonId !== null) {
      assignee = await activeTeamAdult(tx, team.id, input.assigneePersonId);
      if (assignee === undefined) return "no-adult" as const;
    }

    const now = new Date(clock()).toISOString();
    const assigned = await tx
      .update(dutySlots)
      .set({
        assigneePersonId: assignee?.id ?? null,
        assignedByPersonId: assignee === undefined ? null : identity.person.id,
        assignedAt: assignee === undefined ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dutySlots.id, slot.id),
          slot.assigneePersonId === null
            ? isNull(dutySlots.assigneePersonId)
            : eq(dutySlots.assigneePersonId, slot.assigneePersonId),
        ),
      )
      .run();
    const row = await dutySlotById(tx, team.id, occurrence.id, slot.id);
    if (row === undefined) throw new Error("Duty slot disappeared during assignment.");
    if (assigned.changes === 0 && row.assigneePersonId !== input.assigneePersonId) {
      return "changed" as const;
    }
    return { row };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-occurrence") return c.json(eventNotFound, 404);
  if (outcome === "no-slot") return c.json(dutyNotFound, 404);
  if (outcome === "no-adult") return c.json(adultNotFound, 404);
  if (outcome === "unavailable") return c.json(occurrenceUnavailable, 409);
  if (outcome === "changed") return c.json(dutyChanged, 409);
  return c.json({ dutySlot: await projectedDutySlot(db, outcome.row) });
}

export function registerDutyRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  clock: Clock = Date.now,
) {
  return app
    .post("/api/teams/:teamId/occurrences/:occurrenceId/duty-slots", (c) =>
      createDutySlot(c, db, sessions, clock),
    )
    .get("/api/teams/:teamId/occurrences/:occurrenceId/duty-slots", (c) =>
      listDutySlots(c, db, sessions),
    )
    .post("/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/claim", (c) =>
      claimDutySlot(c, db, sessions, clock),
    )
    .post("/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/release", (c) =>
      releaseDutySlot(c, db, sessions, clock),
    )
    .post("/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/assignment", (c) =>
      assignDutySlot(c, db, sessions, clock),
    );
}
