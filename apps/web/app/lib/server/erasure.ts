import { and, eq, inList, ne, or } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import type { Lesto } from "@lesto/web";
import { eraseAccountInputSchema, eraseParticipantInputSchema } from "@snackday/domain";

import type { Clock, SessionService } from "./application-contracts";
import { providerIdentityLinks, verifiedIdentityEmails } from "./authentication";
import { calendarFeedTokens } from "./calendar-feeds";
import { dutySlots } from "./duties";
import { eventAttendance } from "./events";
import {
  accounts,
  authenticatedAdult,
  clearedSessionCookie,
  people,
  revokeAllAccountSessions,
} from "./identity";
import { invitationOutbox } from "./invitation-outbox";
import { invitations } from "./invitations";
import { isManagingGuardian, lessonAnswers } from "../../lessons/lessons";
import { sameDisplayName } from "./people-identity";
import { guardianRelationships, memberships, participants } from "./roster";
import { skillEvents } from "../../skills/skill-events";
import { adultMemberships, teams } from "./teams";

export const ERASED_ADULT_DISPLAY_NAME = "Former member";
const ENDED = "revoked";

const unauthorized = { error: "authentication required" } as const;
const participantNotFound = { error: "participant not found" } as const;
const confirmationMismatch = { error: "confirmation does not match" } as const;

/**
 * Hard-erases one child everywhere: every row that names, dates or describes
 * them, in foreign-key order, inside the caller's transaction.
 */
export async function eraseParticipant(tx: Db, participantId: string): Promise<void> {
  const participant = await tx
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  if (participant === undefined) return;

  await tx.delete(skillEvents).where(eq(skillEvents.participantId, participantId)).run();
  await tx.delete(lessonAnswers).where(eq(lessonAnswers.participantId, participantId)).run();
  await tx.delete(eventAttendance).where(eq(eventAttendance.participantId, participantId)).run();
  const childInvitations = await tx
    .select()
    .from(invitations)
    .where(eq(invitations.participantId, participantId))
    .all();
  const invitationIds = childInvitations.map((row) => row.id);
  if (invitationIds.length > 0) {
    await tx
      .delete(invitationOutbox)
      .where(inList(invitationOutbox.invitationId, invitationIds))
      .run();
    await tx.delete(invitations).where(inList(invitations.id, invitationIds)).run();
  }
  await tx.delete(memberships).where(eq(memberships.memberParticipantId, participantId)).run();
  await tx
    .delete(guardianRelationships)
    .where(eq(guardianRelationships.participantId, participantId))
    .run();
  await tx.delete(participants).where(eq(participants.id, participantId)).run();
  await tx.delete(people).where(eq(people.id, participant.personId)).run();
}

/** Active teams where this adult is the only owner left. */
async function soleOwnedTeams(tx: Db, personId: string) {
  const activeTeams = await tx.select().from(teams).where(eq(teams.status, "active")).all();
  const owned = [];
  for (const team of activeTeams) {
    const ownerMemberships = await tx
      .select()
      .from(adultMemberships)
      .where(
        and(
          eq(adultMemberships.teamId, team.id),
          eq(adultMemberships.role, "owner"),
          eq(adultMemberships.status, "active"),
        ),
      )
      .all();
    const owners = new Set(ownerMemberships.map((row) => row.personId));
    const creator = await tx
      .select()
      .from(people)
      .where(eq(people.id, team.createdByPersonId))
      .get();
    if (creator?.status === "active") owners.add(creator.id);
    if (owners.has(personId) && owners.size === 1) owned.push({ id: team.id, name: team.name });
  }
  return owned;
}

/** Children whose only active managing guardian is this adult. */
async function soleGuardianOf(tx: Db, personId: string) {
  const edges = await tx
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.guardianPersonId, personId),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .all();
  const children = [];
  for (const edge of edges) {
    const others = await tx
      .select()
      .from(guardianRelationships)
      .where(
        and(
          eq(guardianRelationships.participantId, edge.participantId),
          eq(guardianRelationships.status, "active"),
          ne(guardianRelationships.guardianPersonId, personId),
        ),
      )
      .all();
    const othersManage = others.some((row) =>
      (JSON.parse(row.permissions) as string[]).includes("participant.manage"),
    );
    if (!othersManage) children.push({ participantId: edge.participantId });
  }
  return children;
}

export type AccountEraseOutcome =
  | { readonly status: "erased" }
  | {
      readonly status: "blocked";
      readonly soleOwnerTeams: readonly { id: string; name: string }[];
      readonly soleGuardianOf: readonly { participantId: string }[];
    };

/**
 * Tombstones one adult. Teams, events and receipts keep NOT NULL references
 * to the person and account rows, so those rows stay, renamed and marked
 * deleted; every email, sign-in link, feed and membership is removed or ended.
 */
export async function eraseAccount(
  tx: Db,
  identity: { readonly accountId: string; readonly personId: string },
  nowIso: string,
): Promise<AccountEraseOutcome> {
  const soleOwnerTeams = await soleOwnedTeams(tx, identity.personId);
  const soleGuardian = await soleGuardianOf(tx, identity.personId);
  if (soleOwnerTeams.length > 0 || soleGuardian.length > 0) {
    return { status: "blocked", soleOwnerTeams, soleGuardianOf: soleGuardian };
  }

  const emails = await tx
    .select()
    .from(verifiedIdentityEmails)
    .where(eq(verifiedIdentityEmails.accountId, identity.accountId))
    .all();
  const addresses = emails.map((row) => row.normalizedEmail);
  await tx
    .update(invitations)
    .set({ status: ENDED, updatedAt: nowIso })
    .where(
      and(
        eq(invitations.status, "pending"),
        or(
          eq(invitations.createdByPersonId, identity.personId),
          eq(invitations.recipientPersonId, identity.personId),
          ...(addresses.length === 0 ? [] : [inList(invitations.recipientEmail, addresses)]),
        ),
      ),
    )
    .run();
  await tx
    .delete(verifiedIdentityEmails)
    .where(eq(verifiedIdentityEmails.accountId, identity.accountId))
    .run();
  await tx
    .delete(providerIdentityLinks)
    .where(eq(providerIdentityLinks.accountId, identity.accountId))
    .run();
  await tx
    .delete(calendarFeedTokens)
    .where(eq(calendarFeedTokens.personId, identity.personId))
    .run();
  await tx
    .update(dutySlots)
    .set({ assigneePersonId: null, assignedByPersonId: null, assignedAt: null, updatedAt: nowIso })
    .where(eq(dutySlots.assigneePersonId, identity.personId))
    .run();
  await tx
    .update(adultMemberships)
    .set({ status: ENDED, updatedAt: nowIso })
    .where(eq(adultMemberships.personId, identity.personId))
    .run();
  await tx
    .update(memberships)
    .set({ status: ENDED, updatedAt: nowIso })
    .where(eq(memberships.memberPersonId, identity.personId))
    .run();
  await tx
    .update(guardianRelationships)
    .set({ status: ENDED, updatedAt: nowIso })
    .where(eq(guardianRelationships.guardianPersonId, identity.personId))
    .run();
  await tx
    .update(people)
    .set({ displayName: ERASED_ADULT_DISPLAY_NAME, status: "deleted", updatedAt: nowIso })
    .where(eq(people.id, identity.personId))
    .run();
  await tx
    .update(accounts)
    .set({ status: "deleted", updatedAt: nowIso })
    .where(eq(accounts.id, identity.accountId))
    .run();
  return { status: "erased" };
}

export interface ErasureRouteOptions {
  readonly db: Db;
  readonly sql: SqlDatabase;
  readonly sessions: SessionService;
  readonly clock: Clock;
}

export function registerErasureRoutes(app: Lesto, options: ErasureRouteOptions) {
  return app
    .post("/api/participants/:participantId/erase", async (c) => {
      const identity = await authenticatedAdult(options.db, options.sessions, c.header("cookie"));
      if (identity === undefined) return c.json(unauthorized, 401);
      const input = c.valid(eraseParticipantInputSchema);
      const participantId = c.param("participantId");
      const outcome = await options.db.transaction(async (tx) => {
        if (!(await isManagingGuardian(tx, identity.person.id, participantId))) {
          return "not-found" as const;
        }
        const participant = await tx
          .select()
          .from(participants)
          .where(eq(participants.id, participantId))
          .get();
        const child =
          participant === undefined
            ? undefined
            : await tx.select().from(people).where(eq(people.id, participant.personId)).get();
        if (child === undefined) return "not-found" as const;
        if (!sameDisplayName(child.displayName, input.confirmName)) return "mismatch" as const;
        await eraseParticipant(tx, participantId);
        return "erased" as const;
      });
      if (outcome === "not-found") return c.json(participantNotFound, 404);
      if (outcome === "mismatch") return c.json(confirmationMismatch, 422);
      return c.json({ erased: true });
    })
    .post("/api/account/erase", async (c) => {
      const identity = await authenticatedAdult(options.db, options.sessions, c.header("cookie"));
      if (identity === undefined) return c.json(unauthorized, 401);
      c.valid(eraseAccountInputSchema);
      const nowIso = new Date(options.clock()).toISOString();
      const outcome = await options.db.transaction((tx) =>
        eraseAccount(tx, { accountId: identity.account.id, personId: identity.person.id }, nowIso),
      );
      if (outcome.status === "blocked") {
        return c.json(
          {
            error: "account erase blocked",
            soleOwnerTeams: outcome.soleOwnerTeams,
            soleGuardianOf: outcome.soleGuardianOf,
          },
          409,
        );
      }
      await revokeAllAccountSessions(options.sql, identity.account.id);
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": clearedSessionCookie(options.sessions.mode === "verified"),
        },
        body: JSON.stringify({ erased: true }),
      };
    });
}
