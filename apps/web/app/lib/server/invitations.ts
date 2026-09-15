import type { SessionService as Sessions } from "./application-contracts";
import { and, createTableSql, defineTable, dropTableSql, eq, gt, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema, recipientBindingSchema } from "@snackday/domain";
import type { RecipientBinding } from "@snackday/domain";
import { z } from "zod";

import { generateBearerToken, hashBearerToken } from "./bearer-tokens";
import { verifiedRecipientEmails } from "./authentication";
import { accounts, authenticatedAdult, people } from "./identity";
import type { AdultIdentity } from "./identity";
import type { InvitedRole, InviteDeliverer } from "./invite-delivery";
import type { InvitationDeliveryIntent, InvitationOutbox } from "./invitation-outbox";
import {
  DEFAULT_GUARDIAN_PERMISSIONS,
  guardianRelationships,
  memberships,
  participants,
} from "./roster";
import {
  adultMemberships,
  grantedAccess,
  ownedActiveTeam,
  projectTeam,
  roleOutranks,
  teams,
} from "./teams";
import type { TeamRole } from "./teams";

const invitationsV006 = defineTable("invitations", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  invitedRole: text("invited_role").notNull(),
  // When set, accepting makes the adult this participant's guardian, with the
  // relationship label captured at invite time. Create enforces the pairing:
  // participantId and relationship are provided together or not at all.
  participantId: text("participant_id").references(() => participants.id),
  relationship: text("relationship"),
  // How the INVITER refers to the invitee (e.g. "Maya's dad") — never a
  // child's record. It stays inside owner-scoped projections and is excluded
  // from every delivery payload.
  inviteeLabel: text("invitee_label").notNull(),
  // Only the SHA-256 hex of the single-use token; the raw token exists in the
  // response/delivery payload and nowhere else.
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull(),
  createdByPersonId: text("created_by_person_id")
    .notNull()
    .references(() => people.id),
  acceptedByPersonId: text("accepted_by_person_id").references(() => people.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const invitations = defineTable("invitations", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  invitedRole: text("invited_role").notNull(),
  participantId: text("participant_id").references(() => participants.id),
  relationship: text("relationship"),
  inviteeLabel: text("invitee_label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull(),
  createdByPersonId: text("created_by_person_id")
    .notNull()
    .references(() => people.id),
  acceptedByPersonId: text("accepted_by_person_id").references(() => people.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  recipientKind: text("recipient_kind"),
  recipientEmail: text("recipient_email"),
  recipientPersonId: text("recipient_person_id").references(() => people.id),
  replacesGuardianRelationshipId: text("replaces_guardian_relationship_id").references(
    () => guardianRelationships.id,
  ),
});

// The `adult_memberships` table itself lives in teams.ts beside the
// `teamAccess` seam that reads it; acceptance below writes it, and this
// module keeps its migration.
export const createInvitations: MigrationEntry = {
  version: "006_create_invitations",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(invitationsV006));
      schema.execute(createTableSql(adultMemberships));
      schema.execute("CREATE INDEX invitations_team_id_idx ON invitations (team_id)");
      schema.execute(
        "CREATE INDEX adult_memberships_team_id_person_id_idx ON adult_memberships (team_id, person_id)",
      );
    },
    down: (schema) => {
      schema.execute(dropTableSql(adultMemberships));
      schema.execute(dropTableSql(invitations));
    },
  },
};

export const createInvitationRecipientBinding: MigrationEntry = {
  version: "011_create_invitation_recipient_binding",
  migration: {
    up: (schema) => {
      schema.execute("ALTER TABLE invitations ADD COLUMN recipient_kind TEXT");
      schema.execute("ALTER TABLE invitations ADD COLUMN recipient_email TEXT");
      schema.execute("ALTER TABLE invitations ADD COLUMN recipient_person_id TEXT");
      schema.execute("ALTER TABLE invitations ADD COLUMN replaces_guardian_relationship_id TEXT");
      schema.execute(
        "CREATE INDEX invitations_recipient_person_id_idx ON invitations (recipient_person_id)",
      );
    },
    down: (schema) => {
      schema.execute("DROP INDEX invitations_recipient_person_id_idx");
      schema.execute("ALTER TABLE invitations DROP COLUMN replaces_guardian_relationship_id");
      schema.execute("ALTER TABLE invitations DROP COLUMN recipient_person_id");
      schema.execute("ALTER TABLE invitations DROP COLUMN recipient_email");
      schema.execute("ALTER TABLE invitations DROP COLUMN recipient_kind");
    },
  },
};

// Seven days. Parents accept within hours, and `resend` re-arms a fresh token
// cheaply (it rotates the hash, killing the old link), so a short window costs
// the product nothing and shrinks how long a mislaid link stays live.
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const invitedRoleSchema = z.enum(["owner", "adult"] as const satisfies readonly InvitedRole[]);

function isInvitedRole(role: string): role is InvitedRole {
  return role === "owner" || role === "adult";
}

export const createInvitationInputSchema = z
  .strictObject({
    invitedRole: invitedRoleSchema,
    inviteeLabel: z.string().trim().min(1, "Invitee label is required."),
    participantId: z.string().trim().min(1).optional(),
    relationship: guardianRelationshipSchema.shape.relationship.optional(),
    recipientBinding: recipientBindingSchema,
    replacesGuardianRelationshipId: z.string().trim().min(1).optional(),
  })
  .refine((input) => (input.participantId === undefined) === (input.relationship === undefined), {
    message: "participantId and relationship must be provided together",
    path: ["relationship"],
  })
  .refine(
    (input) =>
      input.replacesGuardianRelationshipId === undefined || input.participantId !== undefined,
    {
      message: "replacesGuardianRelationshipId requires participantId",
      path: ["replacesGuardianRelationshipId"],
    },
  );

/**
 * The one body shape both token-bearing POSTs carry — preview and accept. The
 * token travels in a request BODY and never in a path segment or a query
 * parameter, so no access log, proxy, CDN, or span attribute can record it.
 */
export const invitationTokenInputSchema = z.strictObject({
  token: z.string().trim().min(1, "Invitation token is required."),
});

const resendInvitationInputSchema = z.strictObject({
  recipientBinding: recipientBindingSchema.optional(),
  replacesGuardianRelationshipId: z.string().trim().min(1).optional(),
});

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const participantNotFound = { error: "participant not found" } as const;
const invitationNotFound = { error: "invitation not found" } as const;
const invitationAlreadyPending = {
  error: "invitation already pending",
} as const;
const invitationNotPending = { error: "invitation is not pending" } as const;
const invitationAlreadyAccepted = {
  error: "invitation already accepted",
} as const;
const invitationRecipientInvalid = {
  error: "invitation recipient is not eligible",
} as const;
const invitationDeliveryUnavailable = {
  error: "invitation delivery unavailable",
} as const;

// Minting and hashing live in bearer-tokens.ts, shared with the calendar feed
// credential; the invite-named alias keeps this module's vocabulary.
const generateInviteToken = generateBearerToken;
export const hashInviteToken = hashBearerToken;

/**
 * The link shape — the bearer credential lives in the URL FRAGMENT.
 *
 * THE RULE: a bearer credential may never appear in the REQUEST LINE (path or
 * query) of a Snackday URL. A fragment is never transmitted to any server, so
 * this token cannot land in our access logs, a proxy or CDN record, a `Referer`
 * header, or the OTLP `http.path` span attribute — none of which we control,
 * and only one of which a redaction seam of ours could ever reach.
 *
 * `/invite` therefore resolves NOTHING server-side: the landing island reads
 * `location.hash`, strips it from the URL bar and the history entry with
 * `history.replaceState`, and POSTs the token in a request BODY to
 * `/api/invitations/preview` (and to `/api/invitations/accept`).
 */
export function inviteUrlFor(token: string): string {
  return `/invite#${token}`;
}

interface InvitationRow {
  id: string;
  teamId: string;
  invitedRole: string;
  participantId: string | null;
  relationship: string | null;
  inviteeLabel: string;
  tokenHash: string;
  status: string;
  createdByPersonId: string;
  acceptedByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  recipientKind: string | null;
  recipientEmail: string | null;
  recipientPersonId: string | null;
  replacesGuardianRelationshipId: string | null;
}

/**
 * THE status a reader is shown, derived rather than stored.
 *
 * `status` is a LIFECYCLE column — what a human did to the invitation (created,
 * revoked, accepted) — and nothing sweeps it on expiry, so a stored `pending`
 * outlives its own `expiresAt`. Accept and `previewInvitation` have always
 * treated such a row as dead; every reader now agrees, because they all read
 * through this one function. The row itself is left alone on purpose: `resend`
 * re-arms an expired invitation, which needs the lifecycle status, not the
 * projected one.
 */
export function projectedInvitationStatus(
  row: { readonly status: string; readonly expiresAt: string },
  nowIso: string,
): string {
  return row.status === "pending" && row.expiresAt <= nowIso ? "expired" : row.status;
}

// Deliberately drops tokenHash and every person id (creator and acceptor).
function projectInvitation(row: InvitationRow, nowIso: string, link?: string) {
  return {
    id: row.id,
    invitedRole: row.invitedRole,
    inviteeLabel: row.inviteeLabel,
    ...(row.participantId === null ? {} : { participantId: row.participantId }),
    ...(row.relationship === null ? {} : { relationship: row.relationship }),
    status: projectedInvitationStatus(row, nowIso),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(link === undefined ? {} : { inviteUrl: link }),
  };
}

/** Every ACTIVE adult membership one person holds on one team. */
function activeMemberships(tx: Db, teamId: string, personId: string) {
  return tx
    .select()
    .from(adultMemberships)
    .where(
      and(
        eq(adultMemberships.teamId, teamId),
        eq(adultMemberships.personId, personId),
        eq(adultMemberships.status, "active"),
      ),
    )
    .all();
}

/**
 * The role a person ACTUALLY holds on a team right now — their active
 * memberships folded exactly as `teamAccess` folds them — or undefined when no
 * membership is in force. Every surface that reports a role reads it from here,
 * so nobody is ever told they hold something the row does not grant.
 */
async function heldTeamRole(
  tx: Db,
  teamId: string,
  personId: string,
): Promise<TeamRole | undefined> {
  const rows = await activeMemberships(tx, teamId, personId);
  return grantedAccess(rows.map((membership) => membership.role))?.role;
}

/** An active participant rostered on this team, or undefined — 404-hiding. */
async function teamParticipant(tx: Db, teamId: string, participantId: string) {
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
        eq(memberships.teamId, teamId),
        eq(memberships.memberParticipantId, participant.id),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .get();

  return membership === undefined ? undefined : participant;
}

async function confirmedRecipient(tx: Db, personId: string): Promise<boolean> {
  const person = await tx.select().from(people).where(eq(people.id, personId)).get();
  if (person === undefined || person.status !== "active") return false;
  const account = await tx.select().from(accounts).where(eq(accounts.personId, personId)).get();
  return account?.status === "active";
}

async function replacementIsEligible(
  tx: Db,
  participantId: string,
  relationshipId: string,
): Promise<boolean> {
  const edge = await tx
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.id, relationshipId),
        eq(guardianRelationships.participantId, participantId),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .get();
  if (edge === undefined) return false;
  const activeAccount = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.personId, edge.guardianPersonId), eq(accounts.status, "active")))
    .get();
  return activeAccount === undefined;
}

function bindingColumns(binding: RecipientBinding) {
  return binding.kind === "verified_email"
    ? {
        recipientKind: binding.kind,
        recipientEmail: binding.email,
        recipientPersonId: null,
      }
    : {
        recipientKind: binding.kind,
        recipientEmail: null,
        recipientPersonId: binding.personId,
      };
}

function rowRecipient(row: InvitationRow): RecipientBinding | undefined {
  if (row.recipientKind === "verified_email" && row.recipientEmail !== null) {
    return { kind: "verified_email", email: row.recipientEmail };
  }
  if (row.recipientKind === "confirmed_person" && row.recipientPersonId !== null) {
    return { kind: "confirmed_person", personId: row.recipientPersonId };
  }
  return undefined;
}

export async function invitationRecipientMatches(
  db: Db,
  binding: RecipientBinding,
  personId: string,
  emailClaims: (db: Db, personId: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (binding.kind === "confirmed_person") return binding.personId === personId;
  const verified = await emailClaims(db, personId);
  return verified.some((email) => email.trim().toLowerCase() === binding.email);
}

async function recipientMatches(
  db: Db,
  row: InvitationRow,
  personId: string,
  emailClaims: (db: Db, personId: string) => Promise<readonly string[]>,
): Promise<boolean> {
  const binding = rowRecipient(row);
  return binding === undefined
    ? false
    : invitationRecipientMatches(db, binding, personId, emailClaims);
}

export interface InvitationRouteOptions {
  readonly clock?: () => number;
  readonly outbox?: InvitationOutbox;
  readonly verifiedEmails?: (db: Db, personId: string) => Promise<readonly string[]>;
}

type PersistIntent = (intent: InvitationDeliveryIntent) => Promise<void>;

function invitationTransaction<R>(
  db: Db,
  outbox: InvitationOutbox | undefined,
  operation: (tx: Db, persist: PersistIntent) => Promise<R>,
): Promise<R> {
  return outbox === undefined
    ? db.transaction((tx) => operation(tx, () => Promise.resolve()))
    : outbox.transaction(operation);
}

function deliveryFor(
  row: InvitationRow,
  teamName: string,
  inviter: AdultIdentity,
  token: string,
  recipient: RecipientBinding,
) {
  if (!isInvitedRole(row.invitedRole)) throw new Error("Invitation role is not deliverable.");
  return {
    invitationId: row.id,
    teamName,
    inviterDisplayName: inviter.person.displayName,
    invitedRole: row.invitedRole,
    recipient,
    inviteUrl: inviteUrlFor(token),
  };
}

async function deliverInvite(
  deliverer: InviteDeliverer,
  row: InvitationRow,
  teamName: string,
  inviter: AdultIdentity,
  token: string,
  recipient: RecipientBinding,
): Promise<string> {
  const delivery = deliveryFor(row, teamName, inviter, token, recipient);
  // The recipient, team, inviter, role, and link are the complete delivery
  // contract. Invitee labels and participant data never enter the channel.
  await deliverer.deliver(delivery);
  return delivery.inviteUrl;
}

async function createInvitation(
  c: Context<"/api/teams/:teamId/invitations">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
  options: InvitationRouteOptions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);
  if (options.outbox === undefined && deliverer.environment !== "development") {
    return c.json(invitationDeliveryUnavailable, 503);
  }

  const input = c.valid(createInvitationInputSchema);
  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  const outcome = await invitationTransaction(db, options.outbox, async (tx, persist) => {
    const team = await ownedActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    if (input.participantId !== undefined) {
      const rostered = await teamParticipant(tx, team.id, input.participantId);
      if (rostered === undefined) return "no-participant" as const;
    }
    if (
      input.recipientBinding.kind === "confirmed_person" &&
      !(await confirmedRecipient(tx, input.recipientBinding.personId))
    ) {
      return "invalid-recipient" as const;
    }
    if (
      input.replacesGuardianRelationshipId !== undefined &&
      input.participantId !== undefined &&
      !(await replacementIsEligible(tx, input.participantId, input.replacesGuardianRelationshipId))
    ) {
      return "invalid-replacement" as const;
    }

    const now = new Date(options.clock?.() ?? Date.now());
    const nowIso = now.toISOString();
    // LIVE pending only. Without the expiry predicate an invitation that had
    // quietly aged out still blocked the label with a 409 — while its link was
    // already dead everywhere else — so the owner could neither use the old
    // invitation nor create a new one. `gt` here is the same boundary accept
    // and `previewInvitation` apply (`expiresAt <= now` is dead).
    const pending = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.teamId, team.id),
          eq(invitations.inviteeLabel, input.inviteeLabel),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, nowIso),
        ),
      )
      .get();
    if (pending !== undefined) return "duplicate" as const;

    const row = await tx
      .insert(invitations)
      .values({
        id: `invitation_${crypto.randomUUID()}`,
        teamId: team.id,
        invitedRole: input.invitedRole,
        participantId: input.participantId ?? null,
        relationship: input.relationship ?? null,
        inviteeLabel: input.inviteeLabel,
        tokenHash,
        status: "pending",
        // The ACTUAL inviter — an owner-member's invitations record them, not
        // the team creator.
        createdByPersonId: identity.person.id,
        acceptedByPersonId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        ...bindingColumns(input.recipientBinding),
        replacesGuardianRelationshipId: input.replacesGuardianRelationshipId ?? null,
      })
      .returning()
      .get();

    const delivery = deliveryFor(row, team.name, identity, token, input.recipientBinding);
    await persist({ invitationId: row.id, tokenHash, delivery });
    return { row, teamName: team.name, recipient: input.recipientBinding };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-participant") return c.json(participantNotFound, 404);
  if (outcome === "duplicate") return c.json(invitationAlreadyPending, 409);
  if (outcome === "invalid-recipient" || outcome === "invalid-replacement") {
    return c.json(invitationRecipientInvalid, 422);
  }
  await options.outbox?.requestSchedule();
  if (options.outbox !== undefined && deliverer.environment === "development") {
    await options.outbox.drain();
  }

  // Delivery happens AFTER the transaction commits, so a rolled-back
  // invitation can never have leaked a live link.
  const link =
    options.outbox === undefined
      ? await deliverInvite(
          deliverer,
          outcome.row,
          outcome.teamName,
          identity,
          token,
          outcome.recipient,
        )
      : deliverer.environment === "development"
        ? inviteUrlFor(token)
        : undefined;

  return c.json(
    {
      invitation: projectInvitation(
        outcome.row,
        new Date(options.clock?.() ?? Date.now()).toISOString(),
        link,
      ),
    },
    201,
  );
}

async function resendInvitation(
  c: Context<"/api/teams/:teamId/invitations/:invitationId/resend">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
  options: InvitationRouteOptions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);
  if (options.outbox === undefined && deliverer.environment !== "development") {
    return c.json(invitationDeliveryUnavailable, 503);
  }
  const parsedInput = resendInvitationInputSchema.safeParse(c.req.body ?? {});
  if (!parsedInput.success) return c.json({ error: "invalid invitation recipient" }, 400);

  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  const outcome = await invitationTransaction(db, options.outbox, async (tx, persist) => {
    const team = await ownedActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return "no-team" as const;

    const row = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, c.param("invitationId")), eq(invitations.teamId, team.id)))
      .get();
    if (row === undefined) return null;
    if (row.status !== "pending") return "not-pending" as const;

    const requestedBinding = parsedInput.data.recipientBinding;
    if (
      requestedBinding?.kind === "confirmed_person" &&
      !(await confirmedRecipient(tx, requestedBinding.personId))
    ) {
      return "invalid-recipient" as const;
    }
    const participantId = row.participantId;
    const requestedReplacement = parsedInput.data.replacesGuardianRelationshipId;
    if (requestedReplacement !== undefined) {
      if (
        participantId === null ||
        !(await replacementIsEligible(tx, participantId, requestedReplacement))
      ) {
        return "invalid-recipient" as const;
      }
    }
    const existingBinding = rowRecipient(row);
    const recipient = requestedBinding ?? existingBinding;
    if (recipient === undefined) return "invalid-recipient" as const;

    const now = new Date(options.clock?.() ?? Date.now());
    // Rotating the stored hash kills the previously delivered link: its hash
    // no longer matches anything, so accept answers 404 for it.
    await tx
      .update(invitations)
      .set({
        tokenHash,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        updatedAt: now.toISOString(),
        ...(requestedBinding === undefined ? {} : bindingColumns(requestedBinding)),
        ...(requestedReplacement === undefined
          ? {}
          : { replacesGuardianRelationshipId: requestedReplacement }),
      })
      .where(eq(invitations.id, row.id))
      .run();
    const rotated = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (rotated === undefined) throw new Error("Invitation disappeared during resend.");

    const delivery = deliveryFor(rotated, team.name, identity, token, recipient);
    await persist({ invitationId: rotated.id, tokenHash, delivery });
    return { row: rotated, teamName: team.name, recipient };
  });

  if (outcome === "no-team") return c.json(teamNotFound, 404);
  if (outcome === null) return c.json(invitationNotFound, 404);
  if (outcome === "not-pending") return c.json(invitationNotPending, 409);
  if (outcome === "invalid-recipient") return c.json(invitationRecipientInvalid, 422);
  await options.outbox?.requestSchedule();
  if (options.outbox !== undefined && deliverer.environment === "development") {
    await options.outbox.drain();
  }

  const link =
    options.outbox === undefined
      ? await deliverInvite(
          deliverer,
          outcome.row,
          outcome.teamName,
          identity,
          token,
          outcome.recipient,
        )
      : deliverer.environment === "development"
        ? inviteUrlFor(token)
        : undefined;

  return c.json({
    invitation: projectInvitation(
      outcome.row,
      new Date(options.clock?.() ?? Date.now()).toISOString(),
      link,
    ),
  });
}

async function revokeInvitation(
  c: Context<"/api/teams/:teamId/invitations/:invitationId/revoke">,
  db: Db,
  sessions: Sessions,
  options: InvitationRouteOptions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await ownedActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return "no-team" as const;

    const row = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, c.param("invitationId")), eq(invitations.teamId, team.id)))
      .get();
    if (row === undefined) return null;
    // Accepted grants must be withdrawn deliberately (membership management),
    // not by killing the paper trail — so accepted invitations refuse here.
    if (row.status === "accepted") return "accepted" as const;
    // Revoking an already-revoked invitation is an idempotent no-op: the
    // caller's intent ("this link must be dead") already holds.
    if (row.status === "revoked") return { row };

    await tx
      .update(invitations)
      .set({
        status: "revoked",
        updatedAt: new Date(options.clock?.() ?? Date.now()).toISOString(),
      })
      .where(eq(invitations.id, row.id))
      .run();
    const revoked = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (revoked === undefined) throw new Error("Invitation disappeared during revoke.");

    return { row: revoked };
  });

  if (outcome === "no-team") return c.json(teamNotFound, 404);
  if (outcome === null) return c.json(invitationNotFound, 404);
  if (outcome === "accepted") return c.json(invitationAlreadyAccepted, 409);

  return c.json({
    invitation: projectInvitation(
      outcome.row,
      new Date(options.clock?.() ?? Date.now()).toISOString(),
    ),
  });
}

async function listInvitations(
  c: Context<"/api/teams/:teamId/invitations">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
  options: InvitationRouteOptions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  // Invitations are MANAGEMENT surface: the creator and owner-role members see
  // this list identically (pending invite links included). An adult-role
  // member's reads are team + roster only — for them, as for strangers, this
  // answers the hiding 404, so pending links never reach read-only adults.
  const team = await ownedActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(teamNotFound, 404);

  const rows = await db.select().from(invitations).where(eq(invitations.teamId, team.id)).all();
  rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  // A link is offered for LIVE pending invitations only. An expired one projects
  // as `expired` and carries no link: handing the owner a copyable link that is
  // guaranteed to fail is worse than showing none, and `resend` is the affordance
  // that makes it live again.
  const nowIso = new Date(options.clock?.() ?? Date.now()).toISOString();

  return c.json({
    invitations: rows.map((row) =>
      projectInvitation(
        row,
        nowIso,
        projectedInvitationStatus(row, nowIso) === "pending"
          ? deliverer.currentLink(row.id)
          : undefined,
      ),
    ),
  });
}

/**
 * Put the accepting adult on the child's roster as a guardian once. Placeholder
 * replacement is allowed only when the owner named one exact relationship while
 * creating or resending the invitation. Names are never identity evidence.
 */
async function bindGuardianOnAccept(
  tx: Db,
  input: {
    participantId: string;
    relationship: string;
    guardian: { id: string; displayName: string };
    nowIso: string;
    replacesGuardianRelationshipId: string | null;
  },
): Promise<void> {
  const heldEdge = await tx
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.guardianPersonId, input.guardian.id),
        eq(guardianRelationships.participantId, input.participantId),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .get();
  if (heldEdge !== undefined && input.replacesGuardianRelationshipId === null) return;

  if (input.replacesGuardianRelationshipId !== null) {
    await tx
      .update(guardianRelationships)
      .set(
        heldEdge === undefined
          ? { guardianPersonId: input.guardian.id, updatedAt: input.nowIso }
          : { status: "revoked", updatedAt: input.nowIso },
      )
      .where(eq(guardianRelationships.id, input.replacesGuardianRelationshipId))
      .run();
    return;
  }

  await tx
    .insert(guardianRelationships)
    .values({
      id: `guardian_relationship_${crypto.randomUUID()}`,
      guardianPersonId: input.guardian.id,
      participantId: input.participantId,
      relationship: input.relationship,
      status: "active",
      permissions: JSON.stringify(DEFAULT_GUARDIAN_PERMISSIONS),
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .run();
}

async function acceptInvitation(
  c: Context<"/api/invitations/accept">,
  db: Db,
  sessions: Sessions,
  options: InvitationRouteOptions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(invitationTokenInputSchema);
  const tokenHash = await hashInviteToken(input.token);
  const outcome = await db.transaction(async (tx) => {
    const row = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .get();
    // Unknown, revoked, and expired all hide behind the same 404 — a token is
    // not proof an invitation exists.
    if (row === undefined || row.status === "revoked") return null;
    if (!isInvitedRole(row.invitedRole)) return null;

    const team = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, row.teamId), eq(teams.status, "active")))
      .get();
    if (team === undefined) return null;

    if (row.status === "accepted") {
      // Duplicate-accept semantics: IDEMPOTENT for the adult who already
      // accepted (an accept flow retried by refresh/double-tap must not
      // error). A used single-use token presented by a different adult gets
      // the same hiding answer as an unknown token.
      if (row.acceptedByPersonId !== identity.person.id) return null;

      // The retry reports the role in force NOW — a later invitation may have
      // upgraded it. A membership that has since been REVOKED grants nothing,
      // and this endpoint refuses to claim otherwise: the token collapses into
      // the same hiding 404 an unknown one gets.
      const grantedRole = await heldTeamRole(tx, team.id, identity.person.id);
      return grantedRole === undefined ? null : { row, team, grantedRole };
    }

    const nowIso = new Date(options.clock?.() ?? Date.now()).toISOString();
    if (row.expiresAt <= nowIso) return null;
    if (
      !(await recipientMatches(
        tx,
        row,
        identity.person.id,
        options.verifiedEmails ?? verifiedRecipientEmails,
      ))
    ) {
      return null;
    }
    if (
      row.participantId !== null &&
      row.replacesGuardianRelationshipId !== null &&
      !(await replacementIsEligible(tx, row.participantId, row.replacesGuardianRelationshipId))
    ) {
      return null;
    }

    // No identity duplication: the accepting adult keeps their existing
    // Person/Account — acceptance only BINDS that person to the team (and
    // optionally to a participant), it never creates people.
    //
    // A membership already in force is UPGRADED when this invitation outranks
    // it (an adult member who accepts an owner invitation manages from here
    // on) and left completely alone when it would reduce it (an owner who
    // accepts a later adult invitation stays an owner). `grantedRole` is what
    // the row grants once this transaction commits — the ONLY role reported
    // back, so the answer can never outrun the grant.
    const membershipRows = await activeMemberships(tx, team.id, identity.person.id);
    const heldRole = grantedAccess(membershipRows.map((membership) => membership.role))?.role;
    const upgrades = roleOutranks(row.invitedRole, heldRole);

    if (membershipRows.length === 0) {
      await tx
        .insert(adultMemberships)
        .values({
          id: `adult_membership_${crypto.randomUUID()}`,
          teamId: team.id,
          personId: identity.person.id,
          role: row.invitedRole,
          status: "active",
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
    } else if (upgrades) {
      // Every active row moves together: a duplicate row can never be left
      // behind holding a weaker role for the fold to trip over, and since the
      // invited role outranks the strongest of them, no row is reduced.
      await tx
        .update(adultMemberships)
        .set({ role: row.invitedRole, updatedAt: nowIso })
        .where(
          and(
            eq(adultMemberships.teamId, team.id),
            eq(adultMemberships.personId, identity.person.id),
            eq(adultMemberships.status, "active"),
          ),
        )
        .run();
    }
    const grantedRole = upgrades ? row.invitedRole : (heldRole ?? row.invitedRole);

    // Create enforces that participantId and relationship travel together.
    if (row.participantId !== null && row.relationship !== null) {
      await bindGuardianOnAccept(tx, {
        participantId: row.participantId,
        relationship: row.relationship,
        guardian: identity.person,
        nowIso,
        replacesGuardianRelationshipId: row.replacesGuardianRelationshipId,
      });
    }

    await tx
      .update(invitations)
      .set({
        status: "accepted",
        acceptedByPersonId: identity.person.id,
        updatedAt: nowIso,
      })
      .where(eq(invitations.id, row.id))
      .run();
    const accepted = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (accepted === undefined) throw new Error("Invitation disappeared during accept.");

    return { row: accepted, team, grantedRole };
  });

  if (outcome === null) return c.json(invitationNotFound, 404);

  // The accept response deliberately omits the invitee label (the inviter's
  // wording may reference a child's first name) and the participant id — the
  // accepting adult learns the team and the role they now hold, nothing more.
  //
  // `membership.role` is the role the DATABASE grants after this acceptance,
  // which is not always the role the invitation asked for: an owner accepting
  // a later adult invitation keeps `owner`. The invitation's own role is
  // deliberately NOT echoed here — it is the offer, not the grant, and the
  // owner-facing invitation projections are where an offer is read.
  return c.json({
    invitation: { id: outcome.row.id, status: outcome.row.status },
    membership: { role: outcome.grantedRole },
    team: projectTeam(outcome.team),
  });
}

/**
 * The `/invite` landing page's PREVIEW: the non-recipient fields its delivery
 * already exposes — team name, inviter display name, invited role. Anyone
 * holding the link could have read these in the message. The recipient binding,
 * invitee label, participant data, and internal ids stay out by construction.
 *
 * Only a PENDING, unexpired invitation on an active team previews. Unknown,
 * revoked, expired, and accepted tokens all collapse to `undefined`, so the
 * page can render exactly one generic "not valid" state — which of those it
 * was is never distinguishable from outside, exactly like accept's hiding 404.
 * The raw token is hashed in-process, this module never logs it, and it reaches
 * here in a request BODY (`POST /api/invitations/preview`) — never in a path
 * segment or a query parameter (`inviteUrlFor`).
 */
export interface InvitationPreview {
  readonly teamName: string;
  readonly inviterDisplayName: string;
  readonly invitedRole: InvitedRole;
}

export async function previewInvitation(
  db: Db,
  token: string,
  clock: () => number = Date.now,
): Promise<InvitationPreview | undefined> {
  const tokenHash = await hashInviteToken(token);
  const row = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).get();
  if (row === undefined || row.status !== "pending") return undefined;
  if (!isInvitedRole(row.invitedRole)) return undefined;
  if (rowRecipient(row) === undefined) return undefined;
  if (row.expiresAt <= new Date(clock()).toISOString()) return undefined;

  const team = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, row.teamId), eq(teams.status, "active")))
    .get();
  if (team === undefined) return undefined;

  const inviter = await db.select().from(people).where(eq(people.id, row.createdByPersonId)).get();
  if (inviter === undefined) return undefined;

  return {
    teamName: team.name,
    inviterDisplayName: inviter.displayName,
    invitedRole: row.invitedRole,
  };
}

/**
 * The team an invitation joined THIS adult to, and the role they now hold on
 * it — defined only when `personId` is the person who accepted the token,
 * mirroring the accept endpoint's idempotent same-adult semantics so a
 * refreshed landing page shows "you're on the team" instead of a scary invalid
 * state. Every other situation — unknown, revoked, expired, still pending, or
 * accepted by a DIFFERENT adult — is `undefined`: who accepted an invitation is
 * never revealed.
 *
 * `grantedRole` is read from the MEMBERSHIP in force, never from the
 * invitation: a later invitation may have upgraded the role since, and an
 * invitation that would have reduced it changed nothing. A person whose
 * membership has been revoked holds no role at all, so this resolves to
 * `undefined` and the page falls back to its one generic invalid state rather
 * than claiming a grant that no longer exists.
 */
export async function invitationAcceptedBy(
  db: Db,
  token: string,
  personId: string,
): Promise<{ teamName: string; grantedRole: TeamRole } | undefined> {
  const tokenHash = await hashInviteToken(token);
  const row = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).get();
  if (row === undefined || row.status !== "accepted" || row.acceptedByPersonId !== personId) {
    return undefined;
  }
  if (rowRecipient(row) === undefined) return undefined;

  const team = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, row.teamId), eq(teams.status, "active")))
    .get();
  if (team === undefined) return undefined;

  const grantedRole = await heldTeamRole(db, team.id, personId);
  if (grantedRole === undefined) return undefined;

  return { teamName: team.name, grantedRole };
}

/**
 * The landing page's resolution step, over HTTP — the endpoint that exists
 * BECAUSE the token is no longer in the URL the server sees. The token arrives
 * in the request BODY; the answer is exactly one of three things:
 *
 *   - 200 `{ state: "preview", teamName, inviterDisplayName, invitedRole }` —
 *     a pending, unexpired invitation. NO authentication: the invited parent is
 *     signed out by definition, and this says no more than the delivery payload
 *     they already hold.
 *   - 200 `{ state: "accepted", teamName, grantedRole }` — this session's adult
 *     is the one who accepted this token and their membership is still in force
 *     (accept's idempotent-same-adult semantics, so a re-tapped link stays calm).
 *   - 404 `{ error: "invitation not found" }` — everything else.
 *
 * The 404 is the HIDING answer, byte-identical for an unknown token, a revoked
 * one, an expired one, and one accepted by a DIFFERENT adult: a token is not
 * proof an invitation exists, and who accepted one is never revealed. Never a
 * 403 — that would confirm the invitation is real.
 */
async function invitationPreview(
  c: Context<"/api/invitations/preview">,
  db: Db,
  sessions: Sessions,
  options: InvitationRouteOptions,
) {
  const input = c.valid(invitationTokenInputSchema);

  const preview = await previewInvitation(db, input.token, options.clock);
  if (preview !== undefined) return c.json({ state: "preview", ...preview });

  // Only now is a session interesting: a token already accepted BY THIS ADULT
  // resolves to their success state, and by nobody else's.
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity !== undefined) {
    const accepted = await invitationAcceptedBy(db, input.token, identity.person.id);
    if (accepted !== undefined) return c.json({ state: "accepted", ...accepted });
  }

  return c.json(invitationNotFound, 404);
}

export function registerInvitationRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
  options: InvitationRouteOptions = {},
) {
  return app
    .post("/api/teams/:teamId/invitations", (c) =>
      createInvitation(c, db, sessions, deliverer, options),
    )
    .post("/api/teams/:teamId/invitations/:invitationId/resend", (c) =>
      resendInvitation(c, db, sessions, deliverer, options),
    )
    .post("/api/teams/:teamId/invitations/:invitationId/revoke", (c) =>
      revokeInvitation(c, db, sessions, options),
    )
    .get("/api/teams/:teamId/invitations", (c) =>
      listInvitations(c, db, sessions, deliverer, options),
    )
    .post("/api/invitations/preview", (c) => invitationPreview(c, db, sessions, options))
    .post("/api/invitations/accept", (c) => acceptInvitation(c, db, sessions, options));
}
