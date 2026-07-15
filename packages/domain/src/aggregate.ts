import type { Account, GuardianRelationship, Household, Participant, Person } from "./people";
import type { Membership, Role, Season, Team } from "./teams";

export type AggregateIssueCode =
  | "duplicate_id"
  | "missing_reference"
  | "self_guardian"
  | "duplicate_active_guardian"
  | "cross_team_season"
  | "cross_team_role"
  | "cross_season_role";
export interface AggregateIssue {
  code: AggregateIssueCode;
  entityId: string;
  path: string;
}
export interface DomainAggregate {
  people?: readonly Person[];
  accounts?: readonly Account[];
  households?: readonly Household[];
  participants?: readonly Participant[];
  guardianRelationships?: readonly GuardianRelationship[];
  teams?: readonly Team[];
  seasons?: readonly Season[];
  roles?: readonly Role[];
  memberships?: readonly Membership[];
}

type Entity = { id: string };

function findDuplicateIds(value: DomainAggregate): AggregateIssue[] {
  const collections = [
    value.people,
    value.accounts,
    value.households,
    value.participants,
    value.guardianRelationships,
    value.teams,
    value.seasons,
    value.roles,
    value.memberships,
  ];
  const issues: AggregateIssue[] = [];
  for (const collection of collections) {
    const seen = new Set<string>();
    for (const entity of (collection ?? []) as readonly Entity[]) {
      if (seen.has(entity.id))
        issues.push({ code: "duplicate_id", entityId: entity.id, path: "id" });
      seen.add(entity.id);
    }
  }
  return issues;
}

function validatePeopleReferences(value: DomainAggregate): AggregateIssue[] {
  const issues: AggregateIssue[] = [];
  const people = new Map(value.people?.map((x) => [x.id, x]));
  const participants = new Map(value.participants?.map((x) => [x.id, x]));
  for (const account of value.accounts ?? [])
    if (!people.has(account.personId))
      issues.push({ code: "missing_reference", entityId: account.id, path: "personId" });
  for (const participant of value.participants ?? [])
    if (!people.has(participant.personId))
      issues.push({ code: "missing_reference", entityId: participant.id, path: "personId" });
  for (const household of value.households ?? [])
    for (const id of household.memberPersonIds)
      if (!people.has(id))
        issues.push({ code: "missing_reference", entityId: household.id, path: "memberPersonIds" });
  const guardianKeys = new Set<string>();
  for (const edge of value.guardianRelationships ?? []) {
    const participant = participants.get(edge.participantId);
    if (!people.has(edge.guardianPersonId) || !participant)
      issues.push({ code: "missing_reference", entityId: edge.id, path: "guardian" });
    if (participant?.personId === edge.guardianPersonId)
      issues.push({ code: "self_guardian", entityId: edge.id, path: "guardianPersonId" });
    const key = `${edge.guardianPersonId}:${edge.participantId}`;
    if (edge.status === "active" && guardianKeys.has(key))
      issues.push({
        code: "duplicate_active_guardian",
        entityId: edge.id,
        path: "guardianPersonId",
      });
    if (edge.status === "active") guardianKeys.add(key);
  }
  return issues;
}

function validateTeamReferences(value: DomainAggregate): AggregateIssue[] {
  const issues: AggregateIssue[] = [];
  const teams = new Map(value.teams?.map((x) => [x.id, x]));
  const seasons = new Map(value.seasons?.map((x) => [x.id, x]));
  for (const season of value.seasons ?? [])
    if (!teams.has(season.teamId))
      issues.push({ code: "missing_reference", entityId: season.id, path: "teamId" });
  for (const role of value.roles ?? []) {
    if (!teams.has(role.teamId))
      issues.push({ code: "missing_reference", entityId: role.id, path: "teamId" });
    if (role.seasonId && !seasons.has(role.seasonId))
      issues.push({ code: "missing_reference", entityId: role.id, path: "seasonId" });
    if (role.seasonId && seasons.get(role.seasonId)?.teamId !== role.teamId)
      issues.push({ code: "cross_team_season", entityId: role.id, path: "seasonId" });
  }
  return issues;
}

function validateMemberships(value: DomainAggregate): AggregateIssue[] {
  const issues: AggregateIssue[] = [];
  const people = new Map(value.people?.map((x) => [x.id, x]));
  const participants = new Map(value.participants?.map((x) => [x.id, x]));
  const teams = new Map(value.teams?.map((x) => [x.id, x]));
  const seasons = new Map(value.seasons?.map((x) => [x.id, x]));
  const roles = new Map(value.roles?.map((x) => [x.id, x]));
  for (const membership of value.memberships ?? []) {
    const season = seasons.get(membership.seasonId);
    if (!teams.has(membership.teamId) || !season)
      issues.push({ code: "missing_reference", entityId: membership.id, path: "teamId" });
    if (season && season.teamId !== membership.teamId)
      issues.push({ code: "cross_team_season", entityId: membership.id, path: "seasonId" });
    if (membership.member.kind === "person" && !people.has(membership.member.personId))
      issues.push({ code: "missing_reference", entityId: membership.id, path: "member" });
    if (
      membership.member.kind === "participant" &&
      !participants.has(membership.member.participantId)
    )
      issues.push({ code: "missing_reference", entityId: membership.id, path: "member" });
    for (const roleId of membership.roleIds) {
      const role = roles.get(roleId);
      if (!role)
        issues.push({ code: "missing_reference", entityId: membership.id, path: "roleIds" });
      else if (role.teamId !== membership.teamId)
        issues.push({ code: "cross_team_role", entityId: membership.id, path: "roleIds" });
      else if (role.seasonId && role.seasonId !== membership.seasonId)
        issues.push({ code: "cross_season_role", entityId: membership.id, path: "roleIds" });
    }
  }
  return issues;
}

export function validateDomainAggregate(value: DomainAggregate): AggregateIssue[] {
  return [
    ...findDuplicateIds(value),
    ...validatePeopleReferences(value),
    ...validateTeamReferences(value),
    ...validateMemberships(value),
  ];
}
