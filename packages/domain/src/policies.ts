import type { Account, GuardianRelationship } from "./people";
import type { AccountId, ParticipantId, PersonId, SeasonId, TeamId } from "./primitives";
import type { DomainPermission, Membership, Role } from "./teams";

export interface PolicyActor {
  accountId: AccountId;
  personId: PersonId;
}
export interface PolicyTarget {
  teamId: TeamId;
  seasonId: SeasonId;
  participantId?: ParticipantId;
}
export interface PolicyContext {
  account?: Account;
  target?: PolicyTarget;
  memberships: readonly Membership[];
  roles: readonly Role[];
  guardianRelationships: readonly GuardianRelationship[];
}
export type PolicyDenialReason =
  | "no_actor"
  | "inactive_account"
  | "missing_target"
  | "invalid_scope"
  | "not_authorized";
export type PolicyDecision = { allowed: true } | { allowed: false; reason: PolicyDenialReason };

function hasRolePermission(
  actor: PolicyActor,
  permission: DomainPermission,
  target: PolicyTarget,
  memberships: readonly Membership[],
  roles: readonly Role[],
): boolean {
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  return memberships.some(
    (membership) =>
      membership.status === "active" &&
      membership.member.kind === "person" &&
      membership.member.personId === actor.personId &&
      membership.roleIds.some((roleId) => {
        const role = roleMap.get(roleId);
        return (
          role?.status === "active" &&
          role.teamId === target.teamId &&
          (!role.seasonId || role.seasonId === target.seasonId) &&
          role.permissions.includes(permission)
        );
      }),
  );
}

function hasGuardianPermission(
  actor: PolicyActor,
  permission: DomainPermission,
  target: PolicyTarget,
  memberships: readonly Membership[],
  relationships: readonly GuardianRelationship[],
): boolean {
  if (!target.participantId) return false;
  if (!["participant.read", "participant.manage", "team.read", "season.read"].includes(permission))
    return false;
  const rostered = memberships.some(
    (membership) =>
      membership.status === "active" &&
      membership.member.kind === "participant" &&
      membership.member.participantId === target.participantId,
  );
  const guardian = relationships.some(
    (edge) =>
      edge.status === "active" &&
      edge.guardianPersonId === actor.personId &&
      edge.participantId === target.participantId &&
      (permission === "team.read" ||
        permission === "season.read" ||
        edge.permissions.includes(permission as "participant.read" | "participant.manage")),
  );
  return rostered && guardian;
}

export function evaluatePolicy(
  actor: PolicyActor | undefined,
  permission: DomainPermission,
  context: PolicyContext,
): PolicyDecision {
  if (!actor) return { allowed: false, reason: "no_actor" };
  if (
    !context.account ||
    context.account.id !== actor.accountId ||
    context.account.personId !== actor.personId ||
    context.account.status !== "active"
  )
    return { allowed: false, reason: "inactive_account" };
  const target = context.target;
  if (!target) return { allowed: false, reason: "missing_target" };
  const memberships = context.memberships.filter(
    (membership) => membership.teamId === target.teamId && membership.seasonId === target.seasonId,
  );
  if (hasRolePermission(actor, permission, target, memberships, context.roles))
    return { allowed: true };
  if (hasGuardianPermission(actor, permission, target, memberships, context.guardianRelationships))
    return { allowed: true };
  return { allowed: false, reason: "not_authorized" };
}

export const allows = (
  actor: PolicyActor | undefined,
  permission: DomainPermission,
  context: PolicyContext,
) => evaluatePolicy(actor, permission, context).allowed;
