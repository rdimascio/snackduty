import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import {
  accountIdSchema,
  accountSchema,
  evaluatePolicy,
  guardianRelationshipSchema,
  membershipSchema,
  participantIdSchema,
  personIdSchema,
  seasonIdSchema,
  teamIdSchema,
} from "@snackday/domain";
import type { DomainPermission, PolicyContext } from "@snackday/domain";
import { accounts, people } from "./identity";
import { adultMemberships, seasons, teams } from "./teams";
import { guardianRelationships, memberships, participants } from "./roster";

export interface AuthorizationTarget {
  readonly teamId: string;
  readonly seasonId?: string;
  readonly participantId?: string;
}

/** Load evidence inside the caller's transaction; the domain alone decides access. */
export async function authorizationContext(db: Db, personId: string, target: AuthorizationTarget) {
  const account = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.personId, personId), eq(accounts.status, "active")))
    .get();
  const person = await db
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.status, "active")))
    .get();
  if (account === undefined || person === undefined) return undefined;
  const team = await db.select().from(teams).where(eq(teams.id, target.teamId)).get();
  if (team === undefined) return undefined;
  const season =
    target.seasonId === undefined
      ? undefined
      : await db.select().from(seasons).where(eq(seasons.id, target.seasonId)).get();
  const adultRows = await db
    .select()
    .from(adultMemberships)
    .where(and(eq(adultMemberships.teamId, team.id), eq(adultMemberships.personId, personId)))
    .all();
  const child =
    target.participantId === undefined
      ? undefined
      : await db
          .select()
          .from(participants)
          .where(and(eq(participants.id, target.participantId), eq(participants.status, "active")))
          .get();
  const rosterRows =
    child === undefined || target.seasonId === undefined
      ? []
      : await db
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.teamId, team.id),
              eq(memberships.seasonId, target.seasonId),
              eq(memberships.memberKind, "participant"),
              eq(memberships.memberParticipantId, child.id),
            ),
          )
          .all();
  const edges =
    child === undefined
      ? []
      : await db
          .select()
          .from(guardianRelationships)
          .where(
            and(
              eq(guardianRelationships.participantId, child.id),
              eq(guardianRelationships.guardianPersonId, personId),
            ),
          )
          .all();
  const context: PolicyContext = {
    account: accountSchema.parse(account),
    target: {
      teamId: teamIdSchema.parse(target.teamId),
      ...(target.seasonId === undefined ? {} : { seasonId: seasonIdSchema.parse(target.seasonId) }),
      ...(target.participantId === undefined
        ? {}
        : { participantId: participantIdSchema.parse(target.participantId) }),
    },
    team,
    ...(season === undefined ? {} : { season }),
    teamMemberships: adultRows,
    memberships: rosterRows.map((row) =>
      membershipSchema.parse({
        id: row.id,
        teamId: row.teamId,
        seasonId: row.seasonId,
        member: { kind: "participant", participantId: row.memberParticipantId },
        roleIds: [],
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
    roles: [],
    guardianRelationships: edges.map((edge) =>
      guardianRelationshipSchema.parse({
        ...edge,
        permissions: JSON.parse(edge.permissions) as unknown,
      }),
    ),
  };
  return {
    team,
    context,
    actor: {
      accountId: accountIdSchema.parse(account.id),
      personId: personIdSchema.parse(personId),
    },
  };
}

export async function authorizeTeamOperation(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: AuthorizationTarget,
): Promise<boolean> {
  const evidence = await authorizationContext(db, personId, target);
  return (
    evidence !== undefined && evaluatePolicy(evidence.actor, permission, evidence.context).allowed
  );
}
