import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("../lesto.app");

const app = await createApp(config);

async function clearState() {
  // `lesto_rate_limits` is the kernel's shared per-client budget — this suite
  // makes many API calls, so reset it alongside the domain state.
  await config.db.exec(
    "DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const SECOND_PERSON_ID = "person_dev_second_adult";

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

const seasonInput = {
  label: "Fall 2026",
  startDate: "2026-09-01",
  endDate: "2026-11-15",
  timeZone: "America/Los_Angeles",
};

async function createTeam(cookie: string): Promise<string> {
  const created = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Membership Falcons" },
  });
  expect(created.status).toBe(201);
  return (json(created) as { team: { id: string } }).team.id;
}

function createSeason(cookie: string, teamId: string, body: unknown = seasonInput) {
  return app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function addChild(cookie: string, teamId: string, seasonId: string) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body: { displayName: "Casey Kid", birthDate: "2018-04-09" },
  });
}

function attachGuardian(cookie: string, participantId: string) {
  return app.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { ...sameOrigin, cookie },
    body: { displayName: "Alex Guardian", relationship: "parent" },
  });
}

function invite(cookie: string, teamId: string, body: unknown) {
  return app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function accept(cookie: string, token: string) {
  return app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie },
    body: { token },
  });
}

function listTeams(cookie: string) {
  return app.handle("GET", "/api/teams", { headers: { cookie } });
}

function readTeam(cookie: string, teamId: string) {
  return app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
}

function readRoster(cookie: string, teamId: string, seasonId: string) {
  return app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
    headers: { cookie },
  });
}

function listInvitations(cookie: string, teamId: string) {
  return app.handle("GET", `/api/teams/${teamId}/invitations`, { headers: { cookie } });
}

function resendInvitation(cookie: string, teamId: string, invitationId: string) {
  return app.handle("POST", `/api/teams/${teamId}/invitations/${invitationId}/resend`, {
    headers: { ...sameOrigin, cookie },
  });
}

function revokeInvitation(cookie: string, teamId: string, invitationId: string) {
  return app.handle("POST", `/api/teams/${teamId}/invitations/${invitationId}/revoke`, {
    headers: { ...sameOrigin, cookie },
  });
}

interface InvitationBody {
  id: string;
  invitedRole: string;
  inviteeLabel: string;
  status: string;
  inviteUrl?: string;
}

function invitationOf(response: { body: string }): InvitationBody {
  return (json(response) as { invitation: InvitationBody }).invitation;
}

function tokenOf(invitation: InvitationBody): string {
  const url = invitation.inviteUrl ?? "";
  expect(url).toStartWith("/invite/");
  return url.slice("/invite/".length);
}

/** Signs in the second persona and joins `teamId` with `role` via an invitation. */
async function joinTeam(ownerCookie: string, teamId: string, role: "owner" | "adult") {
  const memberCookie = await signIn("second-adult");
  const created = await invite(ownerCookie, teamId, {
    invitedRole: role,
    inviteeLabel: `joining ${role}`,
  });
  expect(created.status).toBe(201);
  expect((await accept(memberCookie, tokenOf(invitationOf(created)))).status).toBe(200);
  return memberCookie;
}

interface TeamListEntry {
  team: { id: string; name: string };
  seasons: { id: string }[];
  access: string;
}

function teamsOf(response: { body: string }): TeamListEntry[] {
  return (json(response) as { teams: TeamListEntry[] }).teams;
}

describe("owner-role membership: full management parity", () => {
  it("lets an owner-member manage seasons and the roster like the creator", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const memberCookie = await joinTeam(ownerCookie, teamId, "owner");

    const createdSeason = await createSeason(memberCookie, teamId);
    expect(createdSeason.status).toBe(201);
    const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;

    const addedChild = await addChild(memberCookie, teamId, seasonId);
    expect(addedChild.status).toBe(201);
    const participantId = (json(addedChild) as { participant: { participantId: string } })
      .participant.participantId;

    expect((await attachGuardian(memberCookie, participantId)).status).toBe(201);

    // The member's reads and the creator's reads see the same shared team.
    for (const cookie of [memberCookie, ownerCookie]) {
      const roster = await readRoster(cookie, teamId, seasonId);
      expect(roster.status).toBe(200);
      const entries = (json(roster) as { roster: { displayName: string }[] }).roster;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.displayName).toBe("Casey Kid");

      const single = await readTeam(cookie, teamId);
      expect(single.status).toBe(200);

      const listed = await listTeams(cookie);
      expect(listed.status).toBe(200);
      const entriesOfList = teamsOf(listed);
      expect(entriesOfList).toHaveLength(1);
      expect(entriesOfList[0]).toMatchObject({ team: { id: teamId }, access: "manage" });
      expect(entriesOfList[0]?.seasons.map((season) => season.id)).toEqual([seasonId]);
    }
  });

  it("runs the invitation surface as an owner-member, attributed to the actual inviter", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const memberCookie = await joinTeam(ownerCookie, teamId, "owner");

    const created = await invite(memberCookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "Kai's mom",
    });
    expect(created.status).toBe(201);
    const invitation = invitationOf(created);
    expect(invitation.status).toBe("pending");

    // createdByPersonId records the ACTUAL inviter, not the team creator.
    expect(
      await config.db
        .prepare("SELECT created_by_person_id FROM invitations WHERE id = ?")
        .get([invitation.id]),
    ).toEqual({ created_by_person_id: SECOND_PERSON_ID });

    const resent = await resendInvitation(memberCookie, teamId, invitation.id);
    expect(resent.status).toBe(200);
    const rotated = invitationOf(resent);
    expect(tokenOf(rotated)).not.toBe(tokenOf(invitation));

    // The owner-member's list is EXACTLY the creator's list — pending invite
    // links included.
    const memberList = await listInvitations(memberCookie, teamId);
    const ownerList = await listInvitations(ownerCookie, teamId);
    expect(memberList.status).toBe(200);
    expect(json(memberList)).toEqual(json(ownerList));
    const listed = (json(memberList) as { invitations: InvitationBody[] }).invitations;
    expect(listed.map((entry) => entry.status).toSorted()).toEqual(["accepted", "pending"]);
    expect(listed.find((entry) => entry.status === "pending")?.inviteUrl).toBe(rotated.inviteUrl);
    // The projection still drops every person id.
    expect(memberList.body).not.toContain(SECOND_PERSON_ID);
    expect(memberList.body).not.toContain("person_dev_adult");

    const revoked = await revokeInvitation(memberCookie, teamId, invitation.id);
    expect(revoked.status).toBe(200);
    expect(invitationOf(revoked).status).toBe("revoked");
  });
});

describe("adult-role membership: reads only", () => {
  it("gives an adult member the team list, team read, and roster read", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const createdSeason = await createSeason(ownerCookie, teamId);
    const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;
    const addedChild = await addChild(ownerCookie, teamId, seasonId);
    const participantId = (json(addedChild) as { participant: { participantId: string } })
      .participant.participantId;
    const memberCookie = await joinTeam(ownerCookie, teamId, "adult");

    const listed = await listTeams(memberCookie);
    expect(listed.status).toBe(200);
    const entries = teamsOf(listed);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ team: { id: teamId }, access: "read" });
    expect(entries[0]?.seasons.map((season) => season.id)).toEqual([seasonId]);

    const single = await readTeam(memberCookie, teamId);
    expect(single.status).toBe(200);

    const roster = await readRoster(memberCookie, teamId, seasonId);
    expect(roster.status).toBe(200);
    const rosterEntries = (json(roster) as { roster: { participantId: string }[] }).roster;
    expect(rosterEntries.map((entry) => entry.participantId)).toEqual([participantId]);

    const serialized = [listed.body, single.body, roster.body].join("\n").toLowerCase();
    for (const forbidden of ["email", "account", "cookie", "token", "person_id"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("hides every management surface from an adult member behind 404", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const createdSeason = await createSeason(ownerCookie, teamId);
    const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;
    const addedChild = await addChild(ownerCookie, teamId, seasonId);
    const participantId = (json(addedChild) as { participant: { participantId: string } })
      .participant.participantId;
    const pending = invitationOf(
      await invite(ownerCookie, teamId, { invitedRole: "adult", inviteeLabel: "stays pending" }),
    );
    const memberCookie = await joinTeam(ownerCookie, teamId, "adult");

    // Mutations AND the invitation list (management surface: it carries live
    // invite links) all answer the same hiding 404 a stranger gets — never 403.
    const hidden = [
      await createSeason(memberCookie, teamId, { ...seasonInput, label: "Member Season" }),
      await addChild(memberCookie, teamId, seasonId),
      await invite(memberCookie, teamId, { invitedRole: "adult", inviteeLabel: "intruder" }),
      await resendInvitation(memberCookie, teamId, pending.id),
      await revokeInvitation(memberCookie, teamId, pending.id),
      await listInvitations(memberCookie, teamId),
    ];
    for (const response of hidden) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }

    const guardianAttach = await attachGuardian(memberCookie, participantId);
    expect(guardianAttach.status).toBe(404);
    expect(json(guardianAttach)).toEqual({ error: "participant not found" });

    // Nothing was written and the pending invitation survived untouched.
    expect(await config.db.prepare("SELECT id FROM seasons").all()).toHaveLength(1);
    expect(await config.db.prepare("SELECT id FROM participants").all()).toHaveLength(1);
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toEqual([]);
    expect(
      await config.db.prepare("SELECT status FROM invitations WHERE id = ?").all([pending.id]),
    ).toEqual([{ status: "pending" }]);
  });
});

describe("membership upgrades: a later invitation that outranks the role in force", () => {
  it("promotes an adult member to owner and hands over management immediately", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const memberCookie = await joinTeam(ownerCookie, teamId, "adult");
    expect(teamsOf(await listTeams(memberCookie))[0]).toMatchObject({ access: "read" });
    // Management is hidden from the adult member before the promotion.
    expect((await createSeason(memberCookie, teamId)).status).toBe(404);

    const promotion = await invite(ownerCookie, teamId, {
      invitedRole: "owner",
      inviteeLabel: "promotion",
    });
    expect(promotion.status).toBe(201);
    const accepted = await accept(memberCookie, tokenOf(invitationOf(promotion)));
    expect(accepted.status).toBe(200);
    expect(json(accepted)).toMatchObject({ membership: { role: "owner" } });

    // Still ONE membership row for this person, now carrying the owner role.
    expect(
      await config.db
        .prepare("SELECT role, status FROM adult_memberships WHERE person_id = ?")
        .all([SECOND_PERSON_ID]),
    ).toEqual([{ role: "owner", status: "active" }]);

    // The promotion is REAL, not just reported: full management parity.
    const createdSeason = await createSeason(memberCookie, teamId);
    expect(createdSeason.status).toBe(201);
    const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;
    expect((await addChild(memberCookie, teamId, seasonId)).status).toBe(201);
    expect((await listInvitations(memberCookie, teamId)).status).toBe(200);
    expect(
      (
        await invite(memberCookie, teamId, {
          invitedRole: "adult",
          inviteeLabel: "invited by them",
        })
      ).status,
    ).toBe(201);
    expect(teamsOf(await listTeams(memberCookie))[0]).toMatchObject({
      team: { id: teamId },
      access: "manage",
    });
  });

  it("never demotes an owner-member who accepts a later adult invitation", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const memberCookie = await joinTeam(ownerCookie, teamId, "owner");

    const demotion = await invite(ownerCookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "demotion",
    });
    expect(demotion.status).toBe(201);
    const invitation = invitationOf(demotion);
    const accepted = await accept(memberCookie, tokenOf(invitation));
    expect(accepted.status).toBe(200);
    // The invitation is consumed, and the role REPORTED is the effective one.
    expect(json(accepted)).toMatchObject({ membership: { role: "owner" } });
    expect(
      await config.db.prepare("SELECT status FROM invitations WHERE id = ?").all([invitation.id]),
    ).toEqual([{ status: "accepted" }]);
    expect(
      await config.db
        .prepare("SELECT role, status FROM adult_memberships WHERE person_id = ?")
        .all([SECOND_PERSON_ID]),
    ).toEqual([{ role: "owner", status: "active" }]);

    // Management survives the would-be demotion.
    expect((await createSeason(memberCookie, teamId)).status).toBe(201);
    expect(teamsOf(await listTeams(memberCookie))[0]).toMatchObject({ access: "manage" });
  });
});

describe("membership lifecycle", () => {
  it("a revoked membership behaves exactly like a stranger again", async () => {
    const ownerCookie = await signIn();
    const teamId = await createTeam(ownerCookie);
    const createdSeason = await createSeason(ownerCookie, teamId);
    const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;
    const memberCookie = await joinTeam(ownerCookie, teamId, "owner");
    expect(teamsOf(await listTeams(memberCookie))).toHaveLength(1);

    await config.db
      .prepare("UPDATE adult_memberships SET status = 'revoked' WHERE person_id = ?")
      .run([SECOND_PERSON_ID]);

    expect(json(await listTeams(memberCookie))).toEqual({ teams: [] });
    const hidden = [
      await readTeam(memberCookie, teamId),
      await readRoster(memberCookie, teamId, seasonId),
      await createSeason(memberCookie, teamId, { ...seasonInput, label: "After Revoke" }),
      await invite(memberCookie, teamId, { invitedRole: "adult", inviteeLabel: "after revoke" }),
      await listInvitations(memberCookie, teamId),
    ];
    for (const response of hidden) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }

    // The creator is untouched by the member's revocation.
    const ownerListed = teamsOf(await listTeams(ownerCookie));
    expect(ownerListed).toHaveLength(1);
    expect(ownerListed[0]).toMatchObject({ team: { id: teamId }, access: "manage" });
    expect(await config.db.prepare("SELECT id FROM seasons").all()).toHaveLength(1);
  });
});
