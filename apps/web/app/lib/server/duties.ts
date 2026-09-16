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
import {
  dutySlotInputSchema,
  dutySlotResponseSchema,
  dutySlotsResponseSchema,
} from "@snackday/domain";
import { z } from "zod";

import type { SessionService as Sessions } from "./application-contracts";
import { activeApplicationActor } from "./coordination-actor";
import type {
  CoordinationOperations,
  CoordinationResult,
  CoordinationServices,
} from "./coordination-contracts";
import { accounts, authenticatedAdult, people } from "./identity";
import { activeOccurrenceForOperation, eventOccurrences } from "./occurrence-access";
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
    up: async (schema) => {
      await schema.execute(createTableSql(dutySlots, schema.dialect));
      await schema.execute(
        "CREATE INDEX duty_slots_team_occurrence_idx ON duty_slots (team_id, occurrence_id)",
      );
      await schema.execute(
        "CREATE INDEX duty_slots_assignee_person_id_idx ON duty_slots (assignee_person_id)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(dutySlots));
    },
  },
};

export const createDutySlotInputSchema = z.strictObject({
  label: z.string().trim().min(1, "Duty label is required.").max(120),
  instructions: z.string().trim().min(1).max(2_000).optional(),
});

const occurrenceTargetSchema = z.strictObject({
  teamId: z.string().trim().min(1),
  occurrenceId: z.string().trim().min(1),
});
const claimDutyTargetSchema = occurrenceTargetSchema.extend({ slotId: z.string().trim().min(1) });

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

async function projectedDutySlotRow(tx: Db, row: NonNullable<DutySlotRow>) {
  const assignee =
    row.assigneePersonId === null
      ? undefined
      : await tx.select().from(people).where(eq(people.id, row.assigneePersonId)).get();
  return projectDutySlot(row, assignee);
}

export async function projectedDutySlot(
  tx: Db,
  teamId: string,
  occurrenceId: string | undefined,
  slotId: string,
) {
  const row = await tx
    .select()
    .from(dutySlots)
    .where(
      occurrenceId === undefined
        ? and(eq(dutySlots.id, slotId), eq(dutySlots.teamId, teamId))
        : and(
            eq(dutySlots.id, slotId),
            eq(dutySlots.teamId, teamId),
            eq(dutySlots.occurrenceId, occurrenceId),
          ),
    )
    .get();
  return row === undefined ? undefined : projectedDutySlotRow(tx, row);
}

export async function projectedDutySlots(tx: Db, teamId: string, occurrenceId: string) {
  const rows = await tx
    .select()
    .from(dutySlots)
    .where(and(eq(dutySlots.teamId, teamId), eq(dutySlots.occurrenceId, occurrenceId)))
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
      : await tx.select().from(people).where(inList(people.id, assigneeIds)).all();
  const assigneesById = new Map(assignees.map((person) => [person.id, person] as const));

  return rows.map((row) =>
    projectDutySlot(
      row,
      row.assigneePersonId === null ? undefined : assigneesById.get(row.assigneePersonId),
    ),
  );
}

export async function insertDutySlot(
  tx: Db,
  command: {
    readonly teamId: string;
    readonly occurrenceId: string;
    readonly input: z.infer<typeof dutySlotInputSchema>;
    readonly actorPersonId: string;
    readonly now: string;
  },
) {
  return tx
    .insert(dutySlots)
    .values({
      id: `duty_slot_${crypto.randomUUID()}`,
      teamId: command.teamId,
      occurrenceId: command.occurrenceId,
      label: command.input.label,
      instructions: command.input.instructions ?? null,
      assigneePersonId: null,
      assignedByPersonId: null,
      assignedAt: null,
      createdByPersonId: command.actorPersonId,
      createdAt: command.now,
      updatedAt: command.now,
    })
    .returning()
    .get();
}

const operationError = <C extends string>(
  status: 400 | 401 | 404 | 409 | 422,
  code: C,
  error: string,
): CoordinationResult<never> => ({ ok: false, status, body: { error, code } });

export function createDutyOperations(
  services: CoordinationServices,
): Pick<CoordinationOperations, "listDutySlots" | "claimDutySlot"> {
  return {
    async listDutySlots(candidateActor, targetInput) {
      const target = occurrenceTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      return services.db.transaction(async (tx) => {
        const actor = await activeApplicationActor(tx, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const team = await readableActiveTeam(tx, target.data.teamId, actor.personId);
        if (team === undefined) return operationError(404, "team_not_found", "team not found");
        const resolved = await activeOccurrenceForOperation(tx, actor.personId, "season.read", {
          teamId: team.id,
          occurrenceId: target.data.occurrenceId,
        });
        if (resolved === undefined)
          return operationError(404, "event_not_found", "event not found");
        return {
          ok: true,
          value: dutySlotsResponseSchema.parse({
            dutySlots: await projectedDutySlots(tx, team.id, resolved.occurrence.id),
          }),
        };
      });
    },

    async claimDutySlot(candidateActor, targetInput) {
      const target = claimDutyTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      return services.db.transaction(async (tx) => {
        const actor = await activeApplicationActor(tx, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const team = await readableActiveTeam(tx, target.data.teamId, actor.personId);
        if (team === undefined) return operationError(404, "team_not_found", "team not found");
        const resolved = await activeOccurrenceForOperation(tx, actor.personId, "season.read", {
          teamId: team.id,
          occurrenceId: target.data.occurrenceId,
        });
        if (resolved === undefined)
          return operationError(404, "event_not_found", "event not found");

        const row = await dutySlotById(tx, team.id, resolved.occurrence.id, target.data.slotId);
        if (row === undefined)
          return operationError(404, "duty_slot_not_found", "duty slot not found");
        if (row.assigneePersonId === actor.personId) {
          return {
            ok: true,
            value: dutySlotResponseSchema.parse({ dutySlot: await projectedDutySlotRow(tx, row) }),
          };
        }
        if (row.assigneePersonId !== null) {
          return operationError(409, "duty_slot_taken", "duty slot is already assigned");
        }
        const now = new Date(services.clock()).toISOString();
        if (resolved.occurrence.status !== "scheduled" || resolved.occurrence.startsAtUtc <= now) {
          return operationError(
            409,
            "event_occurrence_unavailable",
            "event occurrence is not available for duty assignment",
          );
        }

        const claimed = await tx
          .update(dutySlots)
          .set({
            assigneePersonId: actor.personId,
            assignedByPersonId: actor.personId,
            assignedAt: now,
            updatedAt: now,
          })
          .where(and(eq(dutySlots.id, row.id), isNull(dutySlots.assigneePersonId)))
          .run();
        const current = await dutySlotById(tx, team.id, resolved.occurrence.id, row.id);
        if (current === undefined) throw new Error("Duty slot disappeared during claim.");
        if (claimed.changes === 0 && current.assigneePersonId !== actor.personId) {
          return operationError(409, "duty_slot_taken", "duty slot is already assigned");
        }
        return {
          ok: true,
          value: dutySlotResponseSchema.parse({
            dutySlot: await projectedDutySlotRow(tx, current),
          }),
        };
      });
    },
  };
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

    const resolved = await activeOccurrenceForOperation(
      tx,
      identity.person.id,
      "team.operations.manage",
      { teamId: team.id, occurrenceId: c.param("occurrenceId") },
    );
    if (resolved === undefined) return "no-occurrence" as const;
    const occurrence = resolved.occurrence;
    if (!occurrenceAcceptsNewAssignment(occurrence, clock)) return "unavailable" as const;

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
  if (outcome === "unavailable") return c.json(occurrenceUnavailable, 409);
  return c.json({ dutySlot: await projectedDutySlotRow(db, outcome.row) }, 201);
}

async function listDutySlots(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await createDutyOperations({ db, clock }).listDutySlots(
    { accountId: identity.account.id, personId: identity.person.id },
    { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId") },
  );
  if (!outcome.ok) return c.json({ error: outcome.body.error }, outcome.status);
  return c.json(outcome.value);
}

async function claimDutySlot(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/duty-slots/:slotId/claim">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await createDutyOperations({ db, clock }).claimDutySlot(
    { accountId: identity.account.id, personId: identity.person.id },
    {
      teamId: c.param("teamId"),
      occurrenceId: c.param("occurrenceId"),
      slotId: c.param("slotId"),
    },
  );
  if (!outcome.ok) {
    const body = [
      "authentication_required",
      "team_not_found",
      "event_not_found",
      "duty_slot_not_found",
    ].includes(outcome.body.code)
      ? { error: outcome.body.error }
      : outcome.body;
    return c.json(body, outcome.status);
  }
  return c.json(outcome.value);
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
    const resolved = await activeOccurrenceForOperation(tx, identity.person.id, "season.read", {
      teamId: team.id,
      occurrenceId: c.param("occurrenceId"),
    });
    if (resolved === undefined) return "no-occurrence" as const;
    const occurrence = resolved.occurrence;
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
  return c.json({ dutySlot: await projectedDutySlotRow(db, outcome.row) });
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
    const resolved = await activeOccurrenceForOperation(
      tx,
      identity.person.id,
      "team.operations.manage",
      { teamId: team.id, occurrenceId: c.param("occurrenceId") },
    );
    if (resolved === undefined) return "no-occurrence" as const;
    const occurrence = resolved.occurrence;
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
  return c.json({ dutySlot: await projectedDutySlotRow(db, outcome.row) });
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
      listDutySlots(c, db, sessions, clock),
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
