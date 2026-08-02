import type { Sessions } from "@lesto/auth";
import { and, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema } from "@snackday/domain";
import { z } from "zod";

import { authenticatedAdult, people } from "./identity";
import type { AdultIdentity } from "./identity";
import type { InvitedRole, InviteDeliverer } from "./invite-delivery";
import { guardianRelationships, memberships, participants } from "./roster";
import { adultMemberships, manageableActiveTeam, projectTeam, teams } from "./teams";

export const invitations = defineTable("invitations", {
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

// The `adult_memberships` table itself lives in teams.ts beside the
// `teamAccess` seam that reads it; acceptance below writes it, and this
// module keeps its migration.
export const createInvitations: MigrationEntry = {
  version: "006_create_invitations",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(invitations));
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

export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

const invitedRoleSchema = z.enum(["owner", "adult"] as const satisfies readonly InvitedRole[]);

export const createInvitationInputSchema = z
  .strictObject({
    invitedRole: invitedRoleSchema,
    inviteeLabel: z.string().trim().min(1, "Invitee label is required."),
    participantId: z.string().trim().min(1).optional(),
    relationship: guardianRelationshipSchema.shape.relationship.optional(),
  })
  .refine((input) => (input.participantId === undefined) === (input.relationship === undefined), {
    message: "participantId and relationship must be provided together",
    path: ["relationship"],
  });

export const acceptInvitationInputSchema = z.strictObject({
  token: z.string().trim().min(1, "Invitation token is required."),
});

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const participantNotFound = { error: "participant not found" } as const;
const invitationNotFound = { error: "invitation not found" } as const;
const invitationAlreadyPending = { error: "invitation already pending" } as const;
const invitationNotPending = { error: "invitation is not pending" } as const;
const invitationAlreadyAccepted = { error: "invitation already accepted" } as const;

const DEFAULT_GUARDIAN_PERMISSIONS = ["participant.read", "participant.manage"] as const;

function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inviteUrlFor(token: string): string {
  return `/invite/${token}`;
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
}

// Deliberately drops tokenHash and every person id (creator and acceptor).
function projectInvitation(row: InvitationRow, link?: string) {
  return {
    id: row.id,
    invitedRole: row.invitedRole,
    inviteeLabel: row.inviteeLabel,
    ...(row.participantId === null ? {} : { participantId: row.participantId }),
    ...(row.relationship === null ? {} : { relationship: row.relationship }),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(link === undefined ? {} : { inviteUrl: link }),
  };
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

async function deliverInvite(
  deliverer: InviteDeliverer,
  row: InvitationRow,
  teamName: string,
  inviter: AdultIdentity,
  token: string,
): Promise<string> {
  const link = inviteUrlFor(token);
  // PRIVACY: team name + inviter display name + role + link ONLY — the
  // invitee label and any participant data never enter the delivery channel.
  await deliverer.deliver({
    invitationId: row.id,
    teamName,
    inviterDisplayName: inviter.person.displayName,
    invitedRole: row.invitedRole as InvitedRole,
    inviteUrl: link,
  });
  return link;
}

async function createInvitation(
  c: Context<"/api/teams/:teamId/invitations">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(createInvitationInputSchema);
  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    if (input.participantId !== undefined) {
      const rostered = await teamParticipant(tx, team.id, input.participantId);
      if (rostered === undefined) return "no-participant" as const;
    }

    const pending = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.teamId, team.id),
          eq(invitations.inviteeLabel, input.inviteeLabel),
          eq(invitations.status, "pending"),
        ),
      )
      .get();
    if (pending !== undefined) return "duplicate" as const;

    const now = new Date();
    const nowIso = now.toISOString();
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
      })
      .returning()
      .get();

    return { row, teamName: team.name };
  });

  if (outcome === null) return c.json(teamNotFound, 404);
  if (outcome === "no-participant") return c.json(participantNotFound, 404);
  if (outcome === "duplicate") return c.json(invitationAlreadyPending, 409);

  // Delivery happens AFTER the transaction commits, so a rolled-back
  // invitation can never have leaked a live link.
  const link = await deliverInvite(deliverer, outcome.row, outcome.teamName, identity, token);

  return c.json({ invitation: projectInvitation(outcome.row, link) }, 201);
}

async function resendInvitation(
  c: Context<"/api/teams/:teamId/invitations/:invitationId/resend">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return "no-team" as const;

    const row = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, c.param("invitationId")), eq(invitations.teamId, team.id)))
      .get();
    if (row === undefined) return null;
    if (row.status !== "pending") return "not-pending" as const;

    const now = new Date();
    // Rotating the stored hash kills the previously delivered link: its hash
    // no longer matches anything, so accept answers 404 for it.
    await tx
      .update(invitations)
      .set({
        tokenHash,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(eq(invitations.id, row.id))
      .run();
    const rotated = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (rotated === undefined) throw new Error("Invitation disappeared during resend.");

    return { row: rotated, teamName: team.name };
  });

  if (outcome === "no-team") return c.json(teamNotFound, 404);
  if (outcome === null) return c.json(invitationNotFound, 404);
  if (outcome === "not-pending") return c.json(invitationNotPending, 409);

  const link = await deliverInvite(deliverer, outcome.row, outcome.teamName, identity, token);

  return c.json({ invitation: projectInvitation(outcome.row, link) });
}

async function revokeInvitation(
  c: Context<"/api/teams/:teamId/invitations/:invitationId/revoke">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await manageableActiveTeam(tx, c.param("teamId"), identity.person.id);
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
      .set({ status: "revoked", updatedAt: new Date().toISOString() })
      .where(eq(invitations.id, row.id))
      .run();
    const revoked = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (revoked === undefined) throw new Error("Invitation disappeared during revoke.");

    return { row: revoked };
  });

  if (outcome === "no-team") return c.json(teamNotFound, 404);
  if (outcome === null) return c.json(invitationNotFound, 404);
  if (outcome === "accepted") return c.json(invitationAlreadyAccepted, 409);

  return c.json({ invitation: projectInvitation(outcome.row) });
}

async function listInvitations(
  c: Context<"/api/teams/:teamId/invitations">,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  // Invitations are MANAGEMENT surface: the creator and owner-role members see
  // this list identically (pending invite links included). An adult-role
  // member's reads are team + roster only — for them, as for strangers, this
  // answers the hiding 404, so pending links never reach read-only adults.
  const team = await manageableActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(teamNotFound, 404);

  const rows = await db.select().from(invitations).where(eq(invitations.teamId, team.id)).all();
  rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  return c.json({
    invitations: rows.map((row) =>
      projectInvitation(row, row.status === "pending" ? deliverer.currentLink(row.id) : undefined),
    ),
  });
}

async function acceptInvitation(c: Context<"/api/invitations/accept">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const input = c.valid(acceptInvitationInputSchema);
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

    const team = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, row.teamId), eq(teams.status, "active")))
      .get();
    if (team === undefined) return null;

    if (row.status === "accepted") {
      // Duplicate-accept semantics: IDEMPOTENT for the adult who already
      // accepted (an accept flow retried by refresh/double-tap must not
      // error), 409 for anyone else (a used single-use token presented by a
      // different adult is a real conflict) — without revealing who accepted.
      return row.acceptedByPersonId === identity.person.id ? { row, team } : ("conflict" as const);
    }

    const nowIso = new Date().toISOString();
    if (row.expiresAt <= nowIso) return null;

    // No identity duplication: the accepting adult keeps their existing
    // Person/Account — acceptance only BINDS that person to the team (and
    // optionally to a participant), it never creates people.
    const existingMembership = await tx
      .select()
      .from(adultMemberships)
      .where(
        and(
          eq(adultMemberships.teamId, team.id),
          eq(adultMemberships.personId, identity.person.id),
          eq(adultMemberships.status, "active"),
        ),
      )
      .get();
    if (existingMembership === undefined) {
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
    }

    // Create enforces that participantId and relationship travel together.
    if (row.participantId !== null && row.relationship !== null) {
      const existingEdge = await tx
        .select()
        .from(guardianRelationships)
        .where(
          and(
            eq(guardianRelationships.guardianPersonId, identity.person.id),
            eq(guardianRelationships.participantId, row.participantId),
            eq(guardianRelationships.status, "active"),
          ),
        )
        .get();
      if (existingEdge === undefined) {
        await tx
          .insert(guardianRelationships)
          .values({
            id: `guardian_relationship_${crypto.randomUUID()}`,
            guardianPersonId: identity.person.id,
            participantId: row.participantId,
            relationship: row.relationship,
            status: "active",
            permissions: JSON.stringify(DEFAULT_GUARDIAN_PERMISSIONS),
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .run();
      }
    }

    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedByPersonId: identity.person.id, updatedAt: nowIso })
      .where(eq(invitations.id, row.id))
      .run();
    const accepted = await tx.select().from(invitations).where(eq(invitations.id, row.id)).get();
    if (accepted === undefined) throw new Error("Invitation disappeared during accept.");

    return { row: accepted, team };
  });

  if (outcome === null) return c.json(invitationNotFound, 404);
  if (outcome === "conflict") return c.json(invitationAlreadyAccepted, 409);

  // The accept response deliberately omits the invitee label (the inviter's
  // wording may reference a child's first name) and the participant id — the
  // accepting adult learns the team and role they now hold, nothing more.
  return c.json({
    invitation: {
      id: outcome.row.id,
      invitedRole: outcome.row.invitedRole,
      status: outcome.row.status,
    },
    team: projectTeam(outcome.team),
  });
}

/**
 * The `/invite/<token>` landing page's PREVIEW: exactly the fields the
 * delivery payload already exposes — team name, inviter display name, invited
 * role (see invite-delivery.ts). That is the privacy precedent: anyone holding
 * the link could have read the email that carried these same fields, so
 * showing them requires no authentication. Everything else stays out BY
 * CONSTRUCTION — never the invitee label (the inviter's wording may reference
 * a child), never participant data, never person or team ids.
 *
 * Only a PENDING, unexpired invitation on an active team previews. Unknown,
 * revoked, expired, and accepted tokens all collapse to `undefined`, so the
 * page can render exactly one generic "not valid" state — which of those it
 * was is never distinguishable from outside, exactly like accept's hiding 404.
 * The raw token is hashed in-process and never logged.
 */
export interface InvitationPreview {
  readonly teamName: string;
  readonly inviterDisplayName: string;
  readonly invitedRole: InvitedRole;
}

export async function previewInvitation(
  db: Db,
  token: string,
): Promise<InvitationPreview | undefined> {
  const tokenHash = await hashInviteToken(token);
  const row = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).get();
  if (row === undefined || row.status !== "pending") return undefined;
  if (row.expiresAt <= new Date().toISOString()) return undefined;

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
    invitedRole: row.invitedRole as InvitedRole,
  };
}

/**
 * The team an invitation joined THIS adult to — defined only when `personId`
 * is the person who accepted the token, mirroring the accept endpoint's
 * idempotent same-adult semantics so a refreshed landing page shows "you're
 * on the team" instead of a scary invalid state. Every other situation —
 * unknown, revoked, expired, still pending, or accepted by a DIFFERENT adult —
 * is `undefined`: who accepted an invitation is never revealed.
 */
export async function invitationAcceptedBy(
  db: Db,
  token: string,
  personId: string,
): Promise<{ teamName: string; invitedRole: InvitedRole } | undefined> {
  const tokenHash = await hashInviteToken(token);
  const row = await db.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).get();
  if (row === undefined || row.status !== "accepted" || row.acceptedByPersonId !== personId) {
    return undefined;
  }

  const team = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, row.teamId), eq(teams.status, "active")))
    .get();
  if (team === undefined) return undefined;

  return { teamName: team.name, invitedRole: row.invitedRole as InvitedRole };
}

export function registerInvitationRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  deliverer: InviteDeliverer,
) {
  return app
    .post("/api/teams/:teamId/invitations", (c) => createInvitation(c, db, sessions, deliverer))
    .post("/api/teams/:teamId/invitations/:invitationId/resend", (c) =>
      resendInvitation(c, db, sessions, deliverer),
    )
    .post("/api/teams/:teamId/invitations/:invitationId/revoke", (c) =>
      revokeInvitation(c, db, sessions),
    )
    .get("/api/teams/:teamId/invitations", (c) => listInvitations(c, db, sessions, deliverer))
    .post("/api/invitations/accept", (c) => acceptInvitation(c, db, sessions));
}
