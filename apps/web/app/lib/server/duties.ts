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
  rawChanges,
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
import { proofGuard } from "./authorization";
import type { EvidenceProof, SqlGuard } from "./authorization";
import { activeApplicationActor } from "./coordination-actor";
import type {
  CoordinationOperations,
  CoordinationResult,
  CoordinationServices,
} from "./coordination-contracts";
import { accounts, authenticatedAdult, people } from "./identity";
import { activeOccurrenceForOperation, eventOccurrences } from "./occurrence-access";
import { readableActiveTeam, teamAccess, teams } from "./teams";

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
  now: string,
): boolean {
  return occurrence.status === "scheduled" && occurrence.startsAtUtc > now;
}

function slotOccurrenceOpenForAssignment(now: string): SqlGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM event_occurrences WHERE event_occurrences.id = duty_slots.occurrence_id AND event_occurrences.status = ? AND event_occurrences.starts_at_utc > ?)",
    params: ["scheduled", now],
  };
}

function activeAdultWithAccount(personId: string): SqlGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM people WHERE people.id = ? AND people.status = ?) AND EXISTS (SELECT 1 FROM accounts WHERE accounts.person_id = ? AND accounts.status = ?)",
    params: [personId, "active", personId, "active"],
  };
}

function slotAssigneeIs(personId: string | null): SqlGuard {
  return personId === null
    ? { sql: "duty_slots.assignee_person_id IS NULL", params: [] }
    : { sql: "duty_slots.assignee_person_id = ?", params: [personId] };
}

function guardedSlotAssignment(command: {
  readonly slotId: string;
  readonly expectedAssigneePersonId: string | null;
  readonly assigneePersonId: string | null;
  readonly assignedByPersonId: string | null;
  readonly now: string;
  readonly proof: SqlGuard;
}) {
  const guards: SqlGuard[] = [
    { sql: "duty_slots.id = ?", params: [command.slotId] },
    slotAssigneeIs(command.expectedAssigneePersonId),
    slotOccurrenceOpenForAssignment(command.now),
    ...(command.assigneePersonId === null
      ? []
      : [activeAdultWithAccount(command.assigneePersonId)]),
    command.proof,
  ];
  const assignedAt = command.assigneePersonId === null ? null : command.now;
  return rawChanges(
    `UPDATE duty_slots SET assignee_person_id = ?, assigned_by_person_id = ?, assigned_at = ?, updated_at = ? WHERE ${guards.map((guard) => guard.sql).join(" AND ")}`,
    [
      command.assigneePersonId,
      command.assignedByPersonId,
      assignedAt,
      command.now,
      ...guards.flatMap((guard) => guard.params),
    ],
  );
}

function guardedSlotInsert(command: {
  readonly id: string;
  readonly teamId: string;
  readonly occurrenceId: string;
  readonly input: z.infer<typeof createDutySlotInputSchema>;
  readonly actorPersonId: string;
  readonly now: string;
  readonly proof: SqlGuard;
}) {
  return rawChanges(
    `INSERT INTO duty_slots (id, team_id, occurrence_id, label, instructions, assignee_person_id, assigned_by_person_id, assigned_at, created_by_person_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM event_occurrences WHERE event_occurrences.id = ? AND event_occurrences.team_id = ? AND event_occurrences.status = ? AND event_occurrences.starts_at_utc > ?) AND ${command.proof.sql}`,
    [
      command.id,
      command.teamId,
      command.occurrenceId,
      command.input.label,
      command.input.instructions ?? null,
      command.actorPersonId,
      command.now,
      command.now,
      command.occurrenceId,
      command.teamId,
      "scheduled",
      command.now,
      ...command.proof.params,
    ],
  );
}

function occurrenceById(db: Db, occurrenceId: string) {
  return db.select().from(eventOccurrences).where(eq(eventOccurrences.id, occurrenceId)).get();
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

  return access === undefined ? undefined : { person, proof: access.proof };
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
): Extract<CoordinationResult<never>, { ok: false }> => ({
  ok: false,
  status,
  body: { error, code },
});

export function createDutyOperations(
  services: CoordinationServices,
): Pick<CoordinationOperations, "listDutySlots" | "claimDutySlot"> {
  return {
    async listDutySlots(candidateActor, targetInput) {
      const target = occurrenceTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      const { db } = services;
      const actor = await activeApplicationActor(db, candidateActor);
      if (actor === undefined) {
        return operationError(401, "authentication_required", "authentication required");
      }
      const team = await readableActiveTeam(db, target.data.teamId, actor.personId);
      if (team === undefined) return operationError(404, "team_not_found", "team not found");
      const resolved = await activeOccurrenceForOperation(db, actor.personId, "season.read", {
        teamId: team.id,
        occurrenceId: target.data.occurrenceId,
      });
      if (resolved === undefined) return operationError(404, "event_not_found", "event not found");
      return {
        ok: true,
        value: dutySlotsResponseSchema.parse({
          dutySlots: await projectedDutySlots(db, team.id, resolved.occurrence.id),
        }),
      };
    },

    async claimDutySlot(candidateActor, targetInput) {
      const target = claimDutyTargetSchema.safeParse(targetInput);
      if (!target.success) return operationError(400, "invalid_request", "request is invalid");

      const { db } = services;
      const authorizeClaim = async () => {
        const actor = await activeApplicationActor(db, candidateActor);
        if (actor === undefined) {
          return operationError(401, "authentication_required", "authentication required");
        }
        const access = await teamAccess(db, target.data.teamId, actor.personId);
        if (access === undefined) return operationError(404, "team_not_found", "team not found");
        const resolved = await activeOccurrenceForOperation(db, actor.personId, "season.read", {
          teamId: access.team.id,
          occurrenceId: target.data.occurrenceId,
        });
        if (resolved === undefined) {
          return operationError(404, "event_not_found", "event not found");
        }
        const proofs: readonly EvidenceProof[] = [access.proof, resolved.proof];
        return { ok: true as const, actor, team: access.team, resolved, proofs };
      };
      const authorized = await authorizeClaim();
      if (!authorized.ok) return authorized;
      const { actor, team, resolved } = authorized;

      const slotNotFound = () => operationError(404, "duty_slot_not_found", "duty slot not found");
      const slotTaken = () =>
        operationError(409, "duty_slot_taken", "duty slot is already assigned");
      const occurrenceClosed = () =>
        operationError(
          409,
          "event_occurrence_unavailable",
          "event occurrence is not available for duty assignment",
        );
      const claimedSlot = async (row: NonNullable<DutySlotRow>) => ({
        ok: true as const,
        value: dutySlotResponseSchema.parse({ dutySlot: await projectedDutySlotRow(db, row) }),
      });

      const row = await dutySlotById(db, team.id, resolved.occurrence.id, target.data.slotId);
      if (row === undefined) return slotNotFound();
      if (row.assigneePersonId === actor.personId) return claimedSlot(row);
      if (row.assigneePersonId !== null) return slotTaken();
      const now = new Date(services.clock()).toISOString();
      if (!occurrenceAcceptsNewAssignment(resolved.occurrence, now)) return occurrenceClosed();

      const claim = (proofs: readonly EvidenceProof[]) =>
        guardedSlotAssignment({
          slotId: row.id,
          expectedAssigneePersonId: null,
          assigneePersonId: actor.personId,
          assignedByPersonId: actor.personId,
          now,
          proof: proofGuard(...proofs),
        });
      let [claimed] = await db.batch([claim(authorized.proofs)]);
      if (claimed.changes === 0) {
        const reauthorized = await authorizeClaim();
        if (!reauthorized.ok) return reauthorized;
        [claimed] = await db.batch([claim(reauthorized.proofs)]);
      }
      const current = await dutySlotById(db, team.id, resolved.occurrence.id, row.id);
      if (current === undefined) return slotNotFound();
      if (claimed.changes > 0 || current.assigneePersonId === actor.personId) {
        return claimedSlot(current);
      }
      if (current.assigneePersonId !== null) return slotTaken();

      const occurrence = await occurrenceById(db, resolved.occurrence.id);
      if (occurrence === undefined)
        return operationError(404, "event_not_found", "event not found");
      if (!occurrenceAcceptsNewAssignment(occurrence, now)) return occurrenceClosed();
      return operationError(401, "authentication_required", "authentication required");
    },
  };
}

type SlotWriteAccess = "manage" | "read";

const SLOT_WRITE_PERMISSION = {
  manage: "team.operations.manage",
  read: "season.read",
} as const;

type SlotWriteAuthorization =
  | { readonly ok: false; readonly status: 401 | 404; readonly body: { readonly error: string } }
  | {
      readonly ok: true;
      readonly team: { readonly id: string };
      readonly occurrence: NonNullable<
        Awaited<ReturnType<typeof activeOccurrenceForOperation>>
      >["occurrence"];
      readonly proofs: readonly EvidenceProof[];
    };

/** The team and occurrence checks a duty slot write runs before it writes. */
async function authorizeSlotWrite(
  db: Db,
  personId: string,
  target: { readonly teamId: string; readonly occurrenceId: string },
  level: SlotWriteAccess,
): Promise<SlotWriteAuthorization> {
  const access = await teamAccess(db, target.teamId, personId);
  if (access === undefined || (level === "manage" && !access.capabilities.manage)) {
    return { ok: false, status: 404, body: teamNotFound };
  }
  const resolved = await activeOccurrenceForOperation(db, personId, SLOT_WRITE_PERMISSION[level], {
    teamId: access.team.id,
    occurrenceId: target.occurrenceId,
  });
  if (resolved === undefined) return { ok: false, status: 404, body: eventNotFound };
  return {
    ok: true,
    team: access.team,
    occurrence: resolved.occurrence,
    proofs: [access.proof, resolved.proof],
  };
}

/** Run every check of the request again, from the session on. */
async function reauthorizeSlotWrite(
  db: Db,
  sessions: Sessions,
  cookie: string | undefined,
  target: { readonly teamId: string; readonly occurrenceId: string },
  level: SlotWriteAccess,
): Promise<SlotWriteAuthorization> {
  const identity = await authenticatedAdult(db, sessions, cookie);
  if (identity === undefined) return { ok: false, status: 401, body: unauthorized };
  return authorizeSlotWrite(db, identity.person.id, target, level);
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
  const target = { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId") };
  const authorized = await authorizeSlotWrite(db, identity.person.id, target, "manage");
  if (!authorized.ok) return c.json(authorized.body, authorized.status);
  const { team, occurrence } = authorized;
  const now = new Date(clock()).toISOString();
  if (!occurrenceAcceptsNewAssignment(occurrence, now)) {
    return c.json(occurrenceUnavailable, 409);
  }

  const slotId = `duty_slot_${crypto.randomUUID()}`;
  const insert = (proofs: readonly EvidenceProof[]) =>
    guardedSlotInsert({
      id: slotId,
      teamId: team.id,
      occurrenceId: occurrence.id,
      input,
      actorPersonId: identity.person.id,
      now,
      proof: proofGuard(...proofs),
    });
  let [inserted] = await db.batch([insert(authorized.proofs)]);
  if (inserted.changes === 0) {
    const reauthorized = await reauthorizeSlotWrite(
      db,
      sessions,
      c.header("cookie"),
      target,
      "manage",
    );
    if (!reauthorized.ok) return c.json(reauthorized.body, reauthorized.status);
    [inserted] = await db.batch([insert(reauthorized.proofs)]);
  }
  if (inserted.changes === 0) {
    const current = await occurrenceById(db, occurrence.id);
    return current === undefined ? c.json(eventNotFound, 404) : c.json(occurrenceUnavailable, 409);
  }
  const row = await dutySlotById(db, team.id, occurrence.id, slotId);
  if (row === undefined) throw new Error("Duty slot disappeared after create.");
  return c.json({ dutySlot: await projectedDutySlotRow(db, row) }, 201);
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

  const target = { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId") };
  const authorized = await authorizeSlotWrite(db, identity.person.id, target, "read");
  if (!authorized.ok) return c.json(authorized.body, authorized.status);
  const { team, occurrence } = authorized;
  const slot = await dutySlotById(db, team.id, occurrence.id, c.param("slotId"));
  if (slot === undefined) return c.json(dutyNotFound, 404);
  if (slot.assigneePersonId !== null && slot.assigneePersonId !== identity.person.id) {
    return c.json(dutyTaken, 409);
  }
  const releasedSlot = async (row: NonNullable<DutySlotRow>) =>
    c.json({ dutySlot: await projectedDutySlotRow(db, row) });
  if (slot.assigneePersonId === null) return releasedSlot(slot);
  const now = new Date(clock()).toISOString();
  if (!occurrenceAcceptsNewAssignment(occurrence, now)) return c.json(occurrenceUnavailable, 409);

  const release = (proofs: readonly EvidenceProof[]) =>
    guardedSlotAssignment({
      slotId: slot.id,
      expectedAssigneePersonId: identity.person.id,
      assigneePersonId: null,
      assignedByPersonId: null,
      now,
      proof: proofGuard(...proofs),
    });
  let [released] = await db.batch([release(authorized.proofs)]);
  if (released.changes === 0) {
    const reauthorized = await reauthorizeSlotWrite(
      db,
      sessions,
      c.header("cookie"),
      target,
      "read",
    );
    if (!reauthorized.ok) return c.json(reauthorized.body, reauthorized.status);
    [released] = await db.batch([release(reauthorized.proofs)]);
  }
  const row = await dutySlotById(db, team.id, occurrence.id, slot.id);
  if (row === undefined) return c.json(dutyNotFound, 404);
  if (released.changes > 0 || row.assigneePersonId === null) return releasedSlot(row);
  if (row.assigneePersonId === identity.person.id) return c.json(occurrenceUnavailable, 409);
  return c.json(dutyChanged, 409);
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
  const target = { teamId: c.param("teamId"), occurrenceId: c.param("occurrenceId") };
  const authorized = await authorizeSlotWrite(db, identity.person.id, target, "manage");
  if (!authorized.ok) return c.json(authorized.body, authorized.status);
  const { team, occurrence } = authorized;
  const slot = await dutySlotById(db, team.id, occurrence.id, c.param("slotId"));
  if (slot === undefined) return c.json(dutyNotFound, 404);

  const assignedSlot = async (row: NonNullable<DutySlotRow>) =>
    c.json({ dutySlot: await projectedDutySlotRow(db, row) });
  if (slot.assigneePersonId === input.assigneePersonId) return assignedSlot(slot);
  const now = new Date(clock()).toISOString();
  if (!occurrenceAcceptsNewAssignment(occurrence, now)) return c.json(occurrenceUnavailable, 409);
  const assigneeProofs = async (): Promise<readonly EvidenceProof[] | undefined> => {
    if (input.assigneePersonId === null) return [];
    const assignee = await activeTeamAdult(db, team.id, input.assigneePersonId);
    return assignee === undefined ? undefined : [assignee.proof];
  };
  const firstAssigneeProofs = await assigneeProofs();
  if (firstAssigneeProofs === undefined) return c.json(adultNotFound, 404);

  const assign = (proofs: readonly EvidenceProof[]) =>
    guardedSlotAssignment({
      slotId: slot.id,
      expectedAssigneePersonId: slot.assigneePersonId,
      assigneePersonId: input.assigneePersonId,
      assignedByPersonId: input.assigneePersonId === null ? null : identity.person.id,
      now,
      proof: proofGuard(...proofs),
    });
  let [assigned] = await db.batch([assign([...authorized.proofs, ...firstAssigneeProofs])]);
  if (assigned.changes === 0) {
    const reauthorized = await reauthorizeSlotWrite(
      db,
      sessions,
      c.header("cookie"),
      target,
      "manage",
    );
    if (!reauthorized.ok) return c.json(reauthorized.body, reauthorized.status);
    const freshAssigneeProofs = await assigneeProofs();
    if (freshAssigneeProofs !== undefined) {
      [assigned] = await db.batch([assign([...reauthorized.proofs, ...freshAssigneeProofs])]);
    }
  }
  const row = await dutySlotById(db, team.id, occurrence.id, slot.id);
  if (row === undefined) return c.json(dutyNotFound, 404);
  if (assigned.changes > 0 || row.assigneePersonId === input.assigneePersonId) {
    return assignedSlot(row);
  }
  if (row.assigneePersonId !== slot.assigneePersonId) return c.json(dutyChanged, 409);
  const current = await occurrenceById(db, occurrence.id);
  if (current === undefined) return c.json(eventNotFound, 404);
  if (!occurrenceAcceptsNewAssignment(current, now)) return c.json(occurrenceUnavailable, 409);
  return c.json(adultNotFound, 404);
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
