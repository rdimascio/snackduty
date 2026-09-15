import { describe, expect, it } from "vitest";
import {
  accountSchema,
  guardianRelationshipSchema,
  membershipSchema,
  participantIdSchema,
  seasonIdSchema,
  teamIdSchema,
} from "./index";
import { evaluatePolicy } from "./policies";
import type { PolicyContext } from "./policies";

const meta = { createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" };
const account = accountSchema.parse({
  id: "account_adult",
  personId: "person_adult",
  status: "active",
  ...meta,
});
const actor = { accountId: account.id, personId: account.personId };
const teamId = teamIdSchema.parse("team_family");
const seasonId = seasonIdSchema.parse("season_family");
const participantId = participantIdSchema.parse("participant_child");
function context(role: string): PolicyContext {
  return {
    account,
    target: { teamId, seasonId, participantId },
    team: { id: teamId, status: "active", createdByPersonId: "person_other_owner" },
    season: { id: seasonId, teamId, status: "active" },
    teamMemberships: [{ teamId, personId: actor.personId, role, status: "active" }],
    memberships: [
      membershipSchema.parse({
        id: "membership_child",
        teamId,
        seasonId,
        member: { kind: "participant", participantId },
        roleIds: [],
        status: "active",
        ...meta,
      }),
    ],
    guardianRelationships: [
      guardianRelationshipSchema.parse({
        id: "guardian_edge",
        guardianPersonId: actor.personId,
        participantId,
        relationship: "parent",
        permissions: ["participant.read", "participant.manage"],
        status: "active",
        ...meta,
      }),
    ],
    roles: [],
  };
}

describe("independent team authorization policy", () => {
  it("preserves owner-only delegation, coach operations and additive guardianship", () => {
    for (const role of ["owner", "coach", "adult"]) {
      const evidence = context(role);
      expect(evaluatePolicy(actor, "memberships.manage", evidence).allowed).toBe(role === "owner");
      expect(evaluatePolicy(actor, "team.operations.manage", evidence).allowed).toBe(
        role !== "adult",
      );
      expect(evaluatePolicy(actor, "participant.manage", evidence).allowed).toBe(true);
      expect(
        evaluatePolicy(actor, "participant.read", { ...evidence, guardianRelationships: [] })
          .allowed,
      ).toBe(role !== "adult");
    }
  });
  it("denies revoked and unknown membership even with a guardian relationship", () => {
    const evidence = context("adult");
    for (const teamMemberships of [
      [],
      [{ teamId, personId: actor.personId, role: "owner", status: "revoked" }],
      [{ teamId, personId: actor.personId, role: "administrator", status: "active" }],
    ]) {
      expect(
        evaluatePolicy(actor, "participant.read", { ...evidence, teamMemberships }).allowed,
      ).toBe(false);
    }
  });
  it("denies cross-team, cross-season and unrelated-child evidence", () => {
    const evidence = context("coach");
    expect(
      evaluatePolicy(actor, "participant.read", {
        ...evidence,
        season: { id: seasonId, teamId: "other_team", status: "active" },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(actor, "participant.read", {
        ...evidence,
        target: { teamId, seasonId: seasonIdSchema.parse("other_season"), participantId },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(actor, "participant.read", {
        ...evidence,
        target: { teamId, seasonId, participantId: participantIdSchema.parse("unrelated_child") },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(actor, "team.operations.manage", {
        ...context("adult"),
        teamMemberships: [
          { teamId: "coached_team", personId: actor.personId, role: "coach", status: "active" },
        ],
      }).allowed,
    ).toBe(false);
  });
});
