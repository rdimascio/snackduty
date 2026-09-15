import type { Account, GuardianRelationship } from "./people";
import type { AccountId, ParticipantId, PersonId, SeasonId, TeamId } from "./primitives";
import type { DomainPermission, Membership, Role } from "./teams";

export interface PolicyActor {
  accountId: AccountId;
  personId: PersonId;
}
export interface PolicyTarget {
  teamId: TeamId;
  seasonId?: SeasonId;
  participantId?: ParticipantId;
}
export interface PolicyContext {
  account?: Account;
  target?: PolicyTarget;
  memberships: readonly Membership[];
  roles: readonly Role[];
  guardianRelationships: readonly GuardianRelationship[];
  /** Present for persisted independent teams, whose adult grants span seasons. */
  teamMemberships?: readonly {
    teamId: string;
    personId: string;
    role: string;
    status: string;
  }[];
  team?: { id: string; status: string; createdByPersonId: string };
  season?: { id: string; teamId: string; status: string };
}
export type PolicyDenialReason =
  | "no_actor"
  | "inactive_account"
  | "missing_target"
  | "invalid_scope"
  | "not_authorized";
export type PolicyDecision = { allowed: true } | { allowed: false; reason: PolicyDenialReason };

export type TeamPolicyRole = "owner" | "coach" | "adult";
const roleRank: Record<TeamPolicyRole, number> = { owner: 3, coach: 2, adult: 1 };
export function strongestTeamRole(roles: readonly string[]): TeamPolicyRole | undefined {
  let held: TeamPolicyRole | undefined;
  for (const role of roles) {
    if (role !== "owner" && role !== "coach" && role !== "adult") continue;
    if (held === undefined || roleRank[role] > roleRank[held]) held = role;
  }
  return held;
}

export function teamRoleCapabilities(role: string) {
  return {
    read: role === "owner" || role === "coach" || role === "adult",
    manage: role === "owner" || role === "coach",
    delegate: role === "owner",
  };
}

function teamPermission(role: TeamPolicyRole, permission: DomainPermission): boolean {
  const capabilities = teamRoleCapabilities(role);
  if (["memberships.manage", "roles.manage", "team.settings.manage"].includes(permission)) {
    return capabilities.delegate;
  }
  if (["team.read", "season.read", "roster.read"].includes(permission)) return capabilities.read;
  return (
    ["team.operations.manage", "roster.manage", "participant.read", "participant.manage"].includes(
      permission,
    ) && capabilities.manage
  );
}

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
  if (context.teamMemberships !== undefined) {
    const team = context.team;
    if (!team || team.id !== target.teamId || team.status !== "active") {
      return { allowed: false, reason: "invalid_scope" };
    }
    if (
      target.seasonId !== undefined &&
      (context.season?.id !== target.seasonId ||
        context.season.teamId !== team.id ||
        context.season.status !== "active")
    ) {
      return { allowed: false, reason: "invalid_scope" };
    }
    const role = strongestTeamRole([
      ...(team.createdByPersonId === actor.personId ? ["owner"] : []),
      ...context.teamMemberships
        .filter(
          (membership) =>
            membership.teamId === team.id &&
            membership.personId === actor.personId &&
            membership.status === "active",
        )
        .map((membership) => membership.role),
    ]);
    if (role === undefined) return { allowed: false, reason: "not_authorized" };
    const rostered = context.memberships.some(
      (membership) =>
        membership.status === "active" &&
        membership.teamId === team.id &&
        membership.seasonId === target.seasonId &&
        membership.member.kind === "participant" &&
        membership.member.participantId === target.participantId,
    );
    if (target.participantId !== undefined && !rostered)
      return { allowed: false, reason: "invalid_scope" };
    if (teamPermission(role, permission)) return { allowed: true };
    // Guardianship adds child rights only after current adult team access is established.
    return hasGuardianPermission(
      actor,
      permission,
      target,
      context.memberships.filter(
        (membership) => membership.teamId === team.id && membership.seasonId === target.seasonId,
      ),
      context.guardianRelationships,
    )
      ? { allowed: true }
      : { allowed: false, reason: "not_authorized" };
  }
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
