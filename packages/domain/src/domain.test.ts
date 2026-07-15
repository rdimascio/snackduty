import { describe, expect, it } from "vitest";
import {
  accountSchema,
  auditEventSchema,
  evaluatePolicy,
  guardianRelationshipSchema,
  householdSchema,
  membershipSchema,
  participantSchema,
  personSchema,
  roleSchema,
  seasonSchema,
  teamSchema,
  validateDomainAggregate,
} from "./index";

const now = "2026-07-15T12:00:00Z";
const meta = { createdAt: now, updatedAt: now };
const person = personSchema.parse({ id: "p-child", displayName: "Sam", status: "active", ...meta });
const guardian = personSchema.parse({
  id: "p-parent",
  displayName: "Alex",
  status: "active",
  ...meta,
});
const account = accountSchema.parse({
  id: "a-1",
  personId: guardian.id,
  status: "active",
  ...meta,
});
const participant = participantSchema.parse({
  id: "part-1",
  personId: person.id,
  birthDate: "2021-05-02",
  status: "active",
  ...meta,
});
const team = teamSchema.parse({ id: "team-1", name: "Tigers", status: "active", ...meta });
const season = seasonSchema.parse({
  id: "season-1",
  teamId: team.id,
  label: "Fall",
  startDate: "2026-08-01",
  endDate: "2026-11-01",
  timeZone: "America/Los_Angeles",
  status: "active",
  ...meta,
});
const role = roleSchema.parse({
  id: "role-1",
  teamId: team.id,
  seasonId: season.id,
  kind: "coach",
  name: "Coach",
  permissions: ["team.read", "roster.read", "participant.read"],
  status: "active",
  ...meta,
});
const guardianEdge = guardianRelationshipSchema.parse({
  id: "gr-1",
  guardianPersonId: guardian.id,
  participantId: participant.id,
  relationship: "parent",
  status: "active",
  permissions: ["participant.read", "participant.manage"],
  ...meta,
});
const staffMembership = membershipSchema.parse({
  id: "mem-1",
  teamId: team.id,
  seasonId: season.id,
  member: { kind: "person", personId: guardian.id },
  roleIds: [role.id],
  status: "active",
  ...meta,
});
const childMembership = membershipSchema.parse({
  id: "mem-2",
  teamId: team.id,
  seasonId: season.id,
  member: { kind: "participant", participantId: participant.id },
  roleIds: [],
  status: "active",
  ...meta,
});

describe("domain schemas and aggregates", () => {
  it("models children without accounts and keeps identity separate", () => {
    expect(person).not.toHaveProperty("email");
    expect(participant).not.toHaveProperty("accountId");
    expect(account.personId).toBe(guardian.id);
  });
  it("supports multiple households, guardians, teams and seasons through edges", () => {
    const household = householdSchema.parse({
      id: "h-1",
      name: "Family",
      memberPersonIds: [person.id, guardian.id],
      status: "active",
      ...meta,
    });
    const secondGuardian = personSchema.parse({
      id: "p-parent-2",
      displayName: "Jo",
      status: "active",
      ...meta,
    });
    const secondEdge = guardianRelationshipSchema.parse({
      ...guardianEdge,
      id: "gr-2",
      guardianPersonId: secondGuardian.id,
    });
    expect(
      validateDomainAggregate({
        people: [person, guardian, secondGuardian],
        households: [household],
        participants: [participant],
        guardianRelationships: [guardianEdge, secondEdge],
        teams: [team],
        seasons: [season],
        roles: [role],
        memberships: [staffMembership, childMembership],
      }),
    ).toEqual([]);
  });
});

describe("domain invariant failures", () => {
  it("rejects malformed variants, duplicate sets and reversed dates", () => {
    expect(
      membershipSchema.safeParse({
        ...childMembership,
        member: { kind: "person", personId: guardian.id, participantId: participant.id },
      }).success,
    ).toBe(false);
    expect(
      householdSchema.safeParse({
        id: "h",
        name: "x",
        memberPersonIds: [person.id, person.id],
        status: "active",
        ...meta,
      }).success,
    ).toBe(false);
    expect(
      seasonSchema.safeParse({ ...season, startDate: "2026-12-01", endDate: "2026-01-01" }).success,
    ).toBe(false);
  });
  it("reports stable self-edge and cross-scope issue codes", () => {
    const self = guardianRelationshipSchema.parse({ ...guardianEdge, guardianPersonId: person.id });
    const otherTeam = teamSchema.parse({ ...team, id: "team-2" });
    const otherSeason = seasonSchema.parse({ ...season, id: "season-2", teamId: otherTeam.id });
    const badMembership = membershipSchema.parse({
      ...staffMembership,
      id: "mem-bad",
      teamId: otherTeam.id,
      seasonId: otherSeason.id,
    });
    expect(
      validateDomainAggregate({
        people: [person, guardian],
        participants: [participant],
        guardianRelationships: [self],
        teams: [team, otherTeam],
        seasons: [season, otherSeason],
        roles: [role],
        memberships: [badMembership],
      }).map((x) => x.code),
    ).toEqual(expect.arrayContaining(["self_guardian", "cross_team_role"]));
  });
});

const actor = { accountId: account.id, personId: guardian.id };
const policyContext = {
  account,
  target: { teamId: team.id, seasonId: season.id, participantId: participant.id },
  memberships: [staffMembership, childMembership],
  roles: [role],
  guardianRelationships: [guardianEdge],
};

describe("deny-by-default policy", () => {
  it("denies absent/inactive actors and undeclared permissions", () => {
    expect(evaluatePolicy(undefined, "team.read", policyContext)).toEqual({
      allowed: false,
      reason: "no_actor",
    });
    expect(evaluatePolicy(actor, "roles.manage", policyContext).allowed).toBe(false);
    expect(
      evaluatePolicy(actor, "team.read", {
        ...policyContext,
        account: { ...account, status: "suspended" },
      }).allowed,
    ).toBe(false);
  });
  it("grants only declared active person-role permissions", () => {
    expect(evaluatePolicy(actor, "roster.read", policyContext).allowed).toBe(true);
    expect(evaluatePolicy(actor, "roster.manage", policyContext).allowed).toBe(false);
    expect(
      evaluatePolicy(actor, "team.read", {
        ...policyContext,
        memberships: [{ ...staffMembership, status: "revoked" }],
      }).allowed,
    ).toBe(false);
  });
});

describe("participant and guardian policy boundaries", () => {
  it("never grants authority from participant membership", () => {
    expect(
      evaluatePolicy({ accountId: account.id, personId: person.id }, "team.read", {
        ...policyContext,
        account: { ...account, personId: person.id },
        memberships: [childMembership],
        guardianRelationships: [],
      }).allowed,
    ).toBe(false);
  });
  it("limits guardian access to their active, rostered participant", () => {
    const guardianOnly = { ...policyContext, memberships: [childMembership], roles: [] };
    expect(evaluatePolicy(actor, "participant.manage", guardianOnly).allowed).toBe(true);
    expect(evaluatePolicy(actor, "roster.read", guardianOnly).allowed).toBe(false);
    expect(
      evaluatePolicy(actor, "participant.read", {
        ...guardianOnly,
        guardianRelationships: [{ ...guardianEdge, status: "revoked" }],
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(actor, "participant.read", {
        ...guardianOnly,
        memberships: [{ ...childMembership, status: "revoked" }],
      }).allowed,
    ).toBe(false);
  });
});

describe("privacy-minimized audit events", () => {
  const base = {
    eventId: "event-1",
    occurredAt: now,
    actor: { kind: "account", accountId: account.id, personId: guardian.id },
  } as const;
  it("parses attributed transitions with before and after facts", () => {
    const event = auditEventSchema.parse({
      ...base,
      action: "membership.roles_changed",
      teamId: team.id,
      seasonId: season.id,
      membershipId: staffMembership.id,
      previousRoleIds: [],
      newRoleIds: [role.id],
    });
    expect(event.action).toBe("membership.roles_changed");
  });
  it("rejects unknown, unattributed, malformed and sensitive fields", () => {
    expect(
      auditEventSchema.safeParse({ ...base, action: "unknown", teamId: team.id }).success,
    ).toBe(false);
    expect(
      auditEventSchema.safeParse({
        eventId: "e",
        occurredAt: now,
        action: "team.created",
        teamId: team.id,
      }).success,
    ).toBe(false);
    expect(
      auditEventSchema.safeParse({
        ...base,
        occurredAt: "yesterday",
        action: "team.created",
        teamId: team.id,
      }).success,
    ).toBe(false);
    expect(
      auditEventSchema.safeParse({
        ...base,
        action: "team.created",
        teamId: team.id,
        childName: "Sam",
        email: "private@example.com",
      }).success,
    ).toBe(false);
  });
});
