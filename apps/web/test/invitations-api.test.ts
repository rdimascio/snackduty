import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEV_PERSON_ID } from "../app/lib/server/identity";
import { ensureDevelopmentPersona } from "../app/lib/server/identity";
import { invitationAcceptedBy, previewInvitation } from "../app/lib/server/invitations";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const {
  default: config,
  devInviteDelivery,
  services,
} = await import("./support/application").then((module) => module.testApplication());

const app = await createApp(config);

const db = services.db;

async function clearState() {
  // `lesto_rate_limits` is the kernel's shared per-client budget — this suite
  // makes many API calls, so reset it alongside the domain state.
  await config.db.exec(
    "DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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
const SECOND_ADULT_NAME = "Second Development Adult";

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

const TEAM_NAME = "Invite Falcons";

async function createTeam(cookie: string, name: string): Promise<string> {
  const created = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name },
  });
  expect(created.status).toBe(201);
  return (json(created) as { team: { id: string } }).team.id;
}

async function createTeamAndSeason(cookie: string): Promise<{ teamId: string; seasonId: string }> {
  const teamId = await createTeam(cookie, TEAM_NAME);

  const createdSeason = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(createdSeason.status).toBe(201);

  return {
    teamId,
    seasonId: (json(createdSeason) as { season: { id: string } }).season.id,
  };
}

async function addChild(
  cookie: string,
  teamId: string,
  seasonId: string,
  body?: { displayName: string; birthDate: string },
): Promise<string> {
  const added = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body: body ?? { displayName: "Rowan Child", birthDate: "2018-04-09" },
  });
  expect(added.status).toBe(201);
  return (json(added) as { participant: { participantId: string } }).participant.participantId;
}

async function invite(cookie: string, teamId: string, body: unknown) {
  await ensureDevelopmentPersona(db, "second-adult");
  const boundBody =
    typeof body === "object" && body !== null && !("recipientBinding" in body)
      ? {
          ...body,
          recipientBinding: {
            kind: "confirmed_person",
            personId: SECOND_PERSON_ID,
          },
        }
      : body;
  return app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie },
    body: boundBody,
  });
}

function attachGuardian(cookie: string, participantId: string, body: unknown) {
  return app.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
}

function readRoster(cookie: string, teamId: string, seasonId: string) {
  return app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
    headers: { cookie },
  });
}

interface RosterEntryBody {
  participantId: string;
  displayName: string;
  birthDate?: string;
  status: string;
  guardians: {
    guardianId: string;
    displayName: string;
    relationship: string;
  }[];
  guardianInvitations: { pending: number; expired: number; accepted: number };
}

function rosterOf(response: { body: string }): RosterEntryBody[] {
  return (json(response) as { roster: RosterEntryBody[] }).roster;
}

function expire(invitationId: string) {
  return config.db
    .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
    .run(["2000-01-01T00:00:00.000Z", invitationId]);
}

function listInvitations(cookie: string, teamId: string) {
  return app.handle("GET", `/api/teams/${teamId}/invitations`, {
    headers: { cookie },
  });
}

function accept(cookie: string, token: string) {
  return app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie },
    body: { token },
  });
}

interface InvitationBody {
  id: string;
  invitedRole: string;
  inviteeLabel: string;
  participantId?: string;
  relationship?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  inviteUrl?: string;
}

function invitationOf(response: { body: string }): InvitationBody {
  return (json(response) as { invitation: InvitationBody }).invitation;
}

// The token lives in the URL FRAGMENT, so `/invite` is the entire request line
// a server ever sees. Splitting on `#` here is the link-shape contract.
function tokenOf(invitation: InvitationBody): string {
  const url = invitation.inviteUrl ?? "";
  expect(url).toStartWith("/invite#");
  return url.slice("/invite#".length);
}

/**
 * Blank the OPAQUE random identifiers — record uuids and the 64-hex invite
 * token — before a short-word leak scan. Those digits are hexadecimal, so a run
 * spells `dad` (or any other hex-only word) roughly one time in thirty purely
 * by chance; scanning them tests the random number generator, not the
 * projection. Every id that must not appear is matched by its `<kind>_` PREFIX,
 * which survives this substitution, so the scan keeps all of its teeth.
 */
function withoutOpaqueIds(text: string): string {
  return text
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "[uuid]")
    .replaceAll(/[0-9a-f]{64}/gu, "[token]");
}

describe("generalized authentication", () => {
  it("lets the second persona sign in and hides non-owned teams behind 404", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const secondCookie = await signIn("second-adult");

    const ownList = await app.handle("GET", "/api/teams", {
      headers: { cookie: secondCookie },
    });
    expect(ownList.status).toBe(200);
    expect(json(ownList)).toEqual({ teams: [] });

    const foreignRead = await app.handle("GET", `/api/teams/${teamId}`, {
      headers: { cookie: secondCookie },
    });
    expect(foreignRead.status).toBe(404);
    expect(json(foreignRead)).toEqual({ error: "team not found" });

    const foreignInvite = await invite(secondCookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "somebody",
    });
    expect(foreignInvite.status).toBe(404);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });
});

describe("privacy-aware roster reads", () => {
  it("keeps a manager's own roster full while limiting another team to their readable child", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const ownChildId = await addChild(ownerCookie, teamId, seasonId);
    const teammateId = await addChild(ownerCookie, teamId, seasonId, {
      displayName: "Casey Teammate",
      birthDate: "2019-05-14",
    });
    expect(
      (
        await attachGuardian(ownerCookie, teammateId, {
          displayName: "Private Teammate Guardian",
          relationship: "caregiver",
        })
      ).status,
    ).toBe(201);

    const memberCookie = await signIn("second-adult");
    const guardianInvite = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's parent",
        participantId: ownChildId,
        relationship: "parent",
      }),
    );
    expect((await accept(memberCookie, tokenOf(guardianInvite))).status).toBe(200);

    const managed = await createTeamAndSeason(memberCookie);
    const managedChildId = await addChild(memberCookie, managed.teamId, managed.seasonId, {
      displayName: "Managed Team Child",
      birthDate: "2017-06-12",
    });
    expect(rosterOf(await readRoster(memberCookie, managed.teamId, managed.seasonId))).toEqual([
      {
        participantId: managedChildId,
        displayName: "Managed Team Child",
        birthDate: "2017-06-12",
        status: "active",
        guardians: [],
        guardianInvitations: { pending: 0, expired: 0, accepted: 0 },
      },
    ]);

    const managerRoster = rosterOf(await readRoster(ownerCookie, teamId, seasonId));
    expect(managerRoster.every((entry) => entry.birthDate !== undefined)).toBe(true);
    expect(managerRoster.every((entry) => entry.guardians !== undefined)).toBe(true);
    expect(managerRoster.every((entry) => entry.guardianInvitations !== undefined)).toBe(true);

    const memberRead = await readRoster(memberCookie, teamId, seasonId);
    expect(memberRead.status).toBe(200);
    const memberRoster = (json(memberRead) as { roster: Record<string, unknown>[] }).roster;
    const ownChild = memberRoster.find((entry) => entry.participantId === ownChildId);
    const teammate = memberRoster.find((entry) => entry.participantId === teammateId);

    expect(ownChild).toMatchObject({
      participantId: ownChildId,
      displayName: "Rowan Child",
      birthDate: "2018-04-09",
      status: "active",
      guardianInvitations: { pending: 0, expired: 0, accepted: 1 },
    });
    expect(ownChild?.guardians).toEqual([
      expect.objectContaining({
        displayName: SECOND_ADULT_NAME,
        relationship: "parent",
        permissions: ["participant.read", "participant.manage"],
        status: "active",
      }),
    ]);
    expect(teammate).toEqual({
      participantId: teammateId,
      displayName: "Casey Teammate",
      status: "active",
      guardians: [],
    });
    expect(memberRead.body).not.toContain("2019-05-14");
    expect(memberRead.body).not.toContain("Private Teammate Guardian");
  });

  it("requires an active guardian edge with participant.read", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const participantId = await addChild(ownerCookie, teamId, seasonId);
    const memberCookie = await signIn("second-adult");
    const guardianInvite = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's parent",
        participantId,
        relationship: "parent",
      }),
    );
    expect((await accept(memberCookie, tokenOf(guardianInvite))).status).toBe(200);

    const edge = (await config.db
      .prepare(
        "SELECT id FROM guardian_relationships WHERE participant_id = ? AND guardian_person_id = ?",
      )
      .get([participantId, SECOND_PERSON_ID])) as { id: string };
    const minimal = {
      participantId,
      displayName: "Rowan Child",
      status: "active",
      guardians: [],
    };

    await config.db
      .prepare("UPDATE guardian_relationships SET permissions = ? WHERE id = ?")
      .run([JSON.stringify(["participant.manage"]), edge.id]);
    expect(rosterOf(await readRoster(memberCookie, teamId, seasonId))).toEqual([minimal]);

    await config.db
      .prepare("UPDATE guardian_relationships SET permissions = ?, status = 'revoked' WHERE id = ?")
      .run([JSON.stringify(["participant.read"]), edge.id]);
    expect(rosterOf(await readRoster(memberCookie, teamId, seasonId))).toEqual([minimal]);
  });

  it("does not turn a cross-team guardian edge into roster access", async () => {
    const ownerCookie = await signIn();
    const first = await createTeamAndSeason(ownerCookie);
    await addChild(ownerCookie, first.teamId, first.seasonId, {
      displayName: "First Team Child",
      birthDate: "2017-02-03",
    });
    const second = await createTeamAndSeason(ownerCookie);
    const secondChildId = await addChild(ownerCookie, second.teamId, second.seasonId, {
      displayName: "Other Team Child",
      birthDate: "2016-01-02",
    });
    const memberCookie = await signIn("second-adult");

    const firstTeamInvite = invitationOf(
      await invite(ownerCookie, first.teamId, {
        invitedRole: "adult",
        inviteeLabel: "first team adult",
      }),
    );
    expect((await accept(memberCookie, tokenOf(firstTeamInvite))).status).toBe(200);
    const secondTeamInvite = invitationOf(
      await invite(ownerCookie, second.teamId, {
        invitedRole: "adult",
        inviteeLabel: "other team's guardian",
        participantId: secondChildId,
        relationship: "parent",
      }),
    );
    expect((await accept(memberCookie, tokenOf(secondTeamInvite))).status).toBe(200);

    expect(rosterOf(await readRoster(memberCookie, first.teamId, first.seasonId))).toEqual([
      {
        participantId: expect.any(String) as string,
        displayName: "First Team Child",
        status: "active",
        guardians: [],
      },
    ]);
    expect(rosterOf(await readRoster(memberCookie, second.teamId, second.seasonId))).toEqual([
      expect.objectContaining({
        participantId: secondChildId,
        displayName: "Other Team Child",
        birthDate: "2016-01-02",
        guardians: [expect.objectContaining({ displayName: SECOND_ADULT_NAME })],
      }),
    ]);

    await config.db
      .prepare(
        "UPDATE adult_memberships SET status = 'inactive' WHERE team_id = ? AND person_id = ?",
      )
      .run([second.teamId, SECOND_PERSON_ID]);

    const firstRead = await readRoster(memberCookie, first.teamId, first.seasonId);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body).not.toContain("Other Team Child");
    expect(firstRead.body).not.toContain("2016-01-02");

    const inactiveTeamRead = await readRoster(memberCookie, second.teamId, second.seasonId);
    expect(inactiveTeamRead.status).toBe(404);
    expect(json(inactiveTeamRead)).toEqual({ error: "team not found" });
  });
});

describe("invitation lifecycle", () => {
  it("requires a verified recipient and refuses unknown confirmed people", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);

    await expect(
      app.handle("POST", `/api/teams/${teamId}/invitations`, {
        headers: { ...sameOrigin, cookie },
        body: { invitedRole: "adult", inviteeLabel: "unbound" },
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });

    const unknown = await invite(cookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "unknown person",
      recipientBinding: {
        kind: "confirmed_person",
        personId: "person_missing",
      },
    });
    expect(unknown.status).toBe(422);
    expect(json(unknown)).toEqual({
      error: "invitation recipient is not eligible",
    });
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });

  it("does not let a forwarded link grant the wrong adult", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const secondCookie = await signIn("second-adult");
    const created = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "recipient",
      }),
    );

    const forwarded = await accept(ownerCookie, tokenOf(created));
    expect(forwarded.status).toBe(404);
    expect(json(forwarded)).toEqual({ error: "invitation not found" });
    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toEqual([]);
    expect((await accept(secondCookie, tokenOf(created))).status).toBe(200);
  });

  it("fails closed when a stored invitation carries an unknown role", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const secondCookie = await signIn("second-adult");
    const created = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "bad role",
      }),
    );
    await config.db
      .prepare("UPDATE invitations SET invited_role = 'administrator' WHERE id = ?")
      .run([created.id]);

    expect((await accept(secondCookie, tokenOf(created))).status).toBe(404);
    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toEqual([]);
  });

  it("keeps a legacy unbound row inert until its owner binds it on resend", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const secondCookie = await signIn("second-adult");
    const created = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "legacy",
      }),
    );
    const oldToken = tokenOf(created);
    await config.db
      .prepare(
        "UPDATE invitations SET recipient_kind = NULL, recipient_email = NULL, recipient_person_id = NULL WHERE id = ?",
      )
      .run([created.id]);

    expect(await previewInvitation(db, oldToken)).toBeUndefined();
    expect((await accept(secondCookie, oldToken)).status).toBe(404);

    const rebound = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/resend`,
      {
        headers: { ...sameOrigin, cookie: ownerCookie },
        body: {
          recipientBinding: {
            kind: "confirmed_person",
            personId: SECOND_PERSON_ID,
          },
        },
      },
    );
    expect(rebound.status).toBe(200);
    expect((await accept(secondCookie, tokenOf(invitationOf(rebound)))).status).toBe(200);
  });

  it("creates a pending invitation with a copyable dev link and only a hashed token", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const before = devInviteDelivery.deliveries.length;

    const created = await invite(cookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "Maya's dad",
    });
    expect(created.status).toBe(201);
    const invitation = invitationOf(created);
    expect(invitation).toMatchObject({
      invitedRole: "adult",
      inviteeLabel: "Maya's dad",
      status: "pending",
    });
    expect(invitation.id).toStartWith("invitation_");
    const token = tokenOf(invitation);
    expect(token).toMatch(/^[0-9a-f]{64}$/u);

    // The raw token exists ONLY in the link — no column of the stored row
    // carries it, and the stored hash is not the token.
    const row = (await config.db
      .prepare("SELECT * FROM invitations WHERE id = ?")
      .get([invitation.id])) as Record<string, unknown>;
    expect(String(row.token_hash)).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.token_hash).not.toBe(token);
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(token);
    }

    // The owner-facing projection drops the hash and every person id.
    const serialized = created.body.toLowerCase();
    for (const forbidden of [
      "token_hash",
      "tokenhash",
      "person_dev_adult",
      String(row.token_hash),
    ]) {
      expect(serialized).not.toContain(forbidden.toLowerCase());
    }

    const delivered = devInviteDelivery.deliveries.slice(before);
    expect(delivered).toEqual([
      {
        idempotencyKey: expect.stringMatching(/^invitation:invitation_.+:[a-f0-9]{64}$/u),
        invitationId: invitation.id,
        teamName: "Invite Falcons",
        inviterDisplayName: "Development Adult",
        invitedRole: "adult",
        recipient: { kind: "confirmed_person", personId: SECOND_PERSON_ID },
        inviteUrl: `/invite#${token}`,
      },
    ]);
  });

  it("answers 409 while an invitation with the same label is pending", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);

    expect(
      (
        await invite(cookie, teamId, {
          invitedRole: "adult",
          inviteeLabel: "Maya's dad",
        })
      ).status,
    ).toBe(201);

    const duplicate = await invite(cookie, teamId, {
      invitedRole: "owner",
      inviteeLabel: "Maya's dad",
    });
    expect(duplicate.status).toBe(409);
    expect(json(duplicate)).toEqual({ error: "invitation already pending" });

    expect(
      (
        await invite(cookie, teamId, {
          invitedRole: "adult",
          inviteeLabel: "Maya's mom",
        })
      ).status,
    ).toBe(201);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toHaveLength(2);
  });

  it("lists every invitation state with a link only for pending ones", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const pending = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "stays pending",
      }),
    );
    const revoked = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "gets revoked",
      }),
    );
    await app.handle("POST", `/api/teams/${teamId}/invitations/${revoked.id}/revoke`, {
      headers: { ...sameOrigin, cookie },
    });
    const acceptedInvite = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "gets accepted",
      }),
    );
    expect((await accept(secondCookie, tokenOf(acceptedInvite))).status).toBe(200);

    const listed = await app.handle("GET", `/api/teams/${teamId}/invitations`, {
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    const invitations = (json(listed) as { invitations: InvitationBody[] }).invitations;
    // Same-millisecond creations tie-break on random ids, so compare by id.
    const byId = new Map(invitations.map((entry) => [entry.id, entry]));
    expect(invitations).toHaveLength(3);
    expect(byId.get(pending.id)).toMatchObject({
      status: "pending",
      inviteUrl: pending.inviteUrl,
    });
    expect(byId.get(revoked.id)?.status).toBe("revoked");
    expect(byId.get(revoked.id)?.inviteUrl).toBeUndefined();
    expect(byId.get(acceptedInvite.id)?.status).toBe("accepted");
    expect(byId.get(acceptedInvite.id)?.inviteUrl).toBeUndefined();
    expect(listed.body).not.toContain(SECOND_PERSON_ID);
  });

  it("resend rotates the token so the old link dies", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const oldToken = tokenOf(created);

    const resent = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/resend`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(resent.status).toBe(200);
    const rotated = invitationOf(resent);
    expect(rotated.id).toBe(created.id);
    expect(rotated.status).toBe("pending");
    const newToken = tokenOf(rotated);
    expect(newToken).not.toBe(oldToken);
    expect(rotated.expiresAt >= created.expiresAt).toBe(true);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toHaveLength(1);

    const staleAccept = await accept(secondCookie, oldToken);
    expect(staleAccept.status).toBe(404);
    expect(json(staleAccept)).toEqual({ error: "invitation not found" });

    expect((await accept(secondCookie, newToken)).status).toBe(200);
  });

  it("accept binds membership and guardianship to the existing adult identity", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's dad",
        participantId,
        relationship: "parent",
      }),
    );

    const accepted = await accept(secondCookie, tokenOf(created));
    expect(accepted.status).toBe(200);
    expect(json(accepted)).toEqual({
      invitation: { id: created.id, status: "accepted" },
      // The role REPORTED is the one the membership row grants, not the one the
      // invitation asked for — here they agree.
      membership: { role: "adult" },
      team: {
        id: teamId,
        name: "Invite Falcons",
        status: "active",
        createdAt: expect.any(String) as unknown,
        updatedAt: expect.any(String) as unknown,
      },
    });
    // The accepting adult learns the team and role — never the child's name
    // or the inviter's label for them.
    const scanned = withoutOpaqueIds(accepted.body.toLowerCase());
    for (const forbidden of ["rowan", "dad", "participant_", "person_"]) {
      expect(scanned).not.toContain(forbidden);
    }

    expect(
      await config.db
        .prepare("SELECT team_id, person_id, role, status FROM adult_memberships")
        .all(),
    ).toEqual([
      {
        team_id: teamId,
        person_id: SECOND_PERSON_ID,
        role: "adult",
        status: "active",
      },
    ]);
    expect(
      await config.db
        .prepare(
          "SELECT guardian_person_id, participant_id, relationship, status, permissions FROM guardian_relationships",
        )
        .all(),
    ).toEqual([
      {
        guardian_person_id: SECOND_PERSON_ID,
        participant_id: participantId,
        relationship: "parent",
        status: "active",
        permissions: JSON.stringify(["participant.read", "participant.manage"]),
      },
    ]);

    // No identity duplication: exactly the two persona pairs plus the child's
    // account-less Person exist.
    expect(await config.db.prepare("SELECT id FROM people").all()).toHaveLength(3);
    expect(await config.db.prepare("SELECT id FROM accounts").all()).toHaveLength(2);
  });

  it("repeat accept is idempotent for the recipient and hides it from another adult", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const token = tokenOf(created);

    const first = await accept(secondCookie, token);
    expect(first.status).toBe(200);

    const again = await accept(secondCookie, token);
    expect(again.status).toBe(200);
    expect(json(again)).toEqual(json(first));
    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toHaveLength(1);

    const other = await accept(cookie, token);
    expect(other.status).toBe(404);
    expect(json(other)).toEqual({ error: "invitation not found" });
    expect(other.body).not.toContain(SECOND_PERSON_ID);

    // Once the membership is revoked the adult holds nothing on this team, so
    // the used token stops claiming a role: it hides behind the same 404 an
    // unknown token gets rather than reporting a grant that no longer exists.
    await config.db.exec("UPDATE adult_memberships SET status = 'revoked'");
    const afterRevoke = await accept(secondCookie, token);
    expect(afterRevoke.status).toBe(404);
    expect(json(afterRevoke)).toEqual({ error: "invitation not found" });
  });

  it("an existing member accepts another invitation without a duplicate membership", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const first = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "first invite",
      }),
    );
    const second = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "second invite",
      }),
    );

    expect((await accept(secondCookie, tokenOf(first))).status).toBe(200);
    const again = await accept(secondCookie, tokenOf(second));
    expect(again.status).toBe(200);

    // A second invitation for the SAME role is a no-op on the grant, and the
    // reported role still matches the one row in force.
    expect(json(again)).toMatchObject({ membership: { role: "adult" } });
    expect(await config.db.prepare("SELECT role, status FROM adult_memberships").all()).toEqual([
      { role: "adult", status: "active" },
    ]);
    expect(
      await config.db.prepare("SELECT status FROM invitations ORDER BY created_at, id").all(),
    ).toEqual([{ status: "accepted" }, { status: "accepted" }]);
  });

  it("upgrades the membership when a later invitation outranks the role in force", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const asAdult = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    expect((await accept(secondCookie, tokenOf(asAdult))).status).toBe(200);

    // Re-using the label is legal once the first invitation stops being
    // pending — this is the exact sequence that used to consume the owner
    // invitation while leaving the membership on `adult`.
    const asOwner = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "owner",
        inviteeLabel: "Maya's dad",
      }),
    );
    const upgraded = await accept(secondCookie, tokenOf(asOwner));
    expect(upgraded.status).toBe(200);
    expect(json(upgraded)).toMatchObject({
      invitation: { id: asOwner.id, status: "accepted" },
      membership: { role: "owner" },
    });

    // The GRANT moved with the report: still one row, now owner.
    expect(
      await config.db
        .prepare("SELECT team_id, person_id, role, status FROM adult_memberships")
        .all(),
    ).toEqual([
      {
        team_id: teamId,
        person_id: SECOND_PERSON_ID,
        role: "owner",
        status: "active",
      },
    ]);

    // Both landing pages agree — including the OLDER adult invitation's, which
    // reports the role in force rather than the role it originally offered.
    for (const token of [tokenOf(asOwner), tokenOf(asAdult)]) {
      expect(await invitationAcceptedBy(db, token, SECOND_PERSON_ID)).toEqual({
        teamName: TEAM_NAME,
        grantedRole: "owner",
      });
    }
  });

  it("never demotes: an owner accepting a later adult invitation stays an owner", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const asOwner = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "owner",
        inviteeLabel: "Maya's dad",
      }),
    );
    expect((await accept(secondCookie, tokenOf(asOwner))).status).toBe(200);

    const asAdult = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const accepted = await accept(secondCookie, tokenOf(asAdult));
    expect(accepted.status).toBe(200);

    // The invitation is consumed but grants nothing, so the EFFECTIVE role is
    // reported — never the "adult" the invitation asked for.
    expect(json(accepted)).toMatchObject({
      invitation: { id: asAdult.id, status: "accepted" },
      membership: { role: "owner" },
    });
    expect(await config.db.prepare("SELECT role, status FROM adult_memberships").all()).toEqual([
      { role: "owner", status: "active" },
    ]);
    expect(await invitationAcceptedBy(db, tokenOf(asAdult), SECOND_PERSON_ID)).toEqual({
      teamName: TEAM_NAME,
      grantedRole: "owner",
    });
  });

  it("revokes pending invitations, refuses accepted ones, and re-revokes idempotently", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const token = tokenOf(created);

    const revoked = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/revoke`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(revoked.status).toBe(200);
    expect(invitationOf(revoked).status).toBe("revoked");

    const deadAccept = await accept(secondCookie, token);
    expect(deadAccept.status).toBe(404);
    expect(json(deadAccept)).toEqual({ error: "invitation not found" });

    const reRevoked = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/revoke`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(reRevoked.status).toBe(200);
    expect(invitationOf(reRevoked).status).toBe("revoked");

    const resendDead = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/resend`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(resendDead.status).toBe(409);
    expect(json(resendDead)).toEqual({ error: "invitation is not pending" });

    const acceptedInvite = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "accepted invite",
      }),
    );
    expect((await accept(secondCookie, tokenOf(acceptedInvite))).status).toBe(200);
    const revokeAccepted = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${acceptedInvite.id}/revoke`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(revokeAccepted.status).toBe(409);
    expect(json(revokeAccepted)).toEqual({
      error: "invitation already accepted",
    });
  });

  it("hides expired tokens behind 404 until a resend refreshes the expiry", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    await config.db
      .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .run(["2000-01-01T00:00:00.000Z", created.id]);

    const expired = await accept(secondCookie, tokenOf(created));
    expect(expired.status).toBe(404);
    expect(json(expired)).toEqual({ error: "invitation not found" });

    const resent = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/resend`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(resent.status).toBe(200);
    expect((await accept(secondCookie, tokenOf(invitationOf(resent)))).status).toBe(200);
  });
});

describe("expired invitations", () => {
  it("projects an expired invitation as expired, without a link", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const stillPending = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's mom",
      }),
    );
    await expire(created.id);

    const listed = await listInvitations(cookie, teamId);
    expect(listed.status).toBe(200);
    const byId = new Map(
      (json(listed) as { invitations: InvitationBody[] }).invitations.map((entry) => [
        entry.id,
        entry,
      ]),
    );

    // The self-contradiction is gone: a row whose expiry has passed no longer
    // claims to be pending, and no longer hands out a link that always fails.
    expect(byId.get(created.id)?.status).toBe("expired");
    expect(byId.get(created.id)?.inviteUrl).toBeUndefined();
    expect(byId.get(stillPending.id)?.status).toBe("pending");
    expect(typeof byId.get(stillPending.id)?.inviteUrl).toBe("string");
    // The stored LIFECYCLE column is untouched — `resend` still needs it.
    expect(
      await config.db.prepare("SELECT status FROM invitations WHERE id = ?").all([created.id]),
    ).toEqual([{ status: "pending" }]);
  });

  it("lets the owner re-invite a label whose invitation has expired", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );

    // While it is LIVE the label is held, exactly as before.
    expect(
      (
        await invite(cookie, teamId, {
          invitedRole: "adult",
          inviteeLabel: "Maya's dad",
        })
      ).status,
    ).toBe(409);

    await expire(created.id);

    // Once it has aged out the owner is no longer blocked by an invitation that
    // nothing else in the system still honors.
    const reinvited = await invite(cookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "Maya's dad",
    });
    expect(reinvited.status).toBe(201);
    const fresh = invitationOf(reinvited);
    expect(fresh.status).toBe("pending");

    // The expired link is still dead; the new one works.
    expect((await accept(secondCookie, tokenOf(created))).status).toBe(404);
    expect((await accept(secondCookie, tokenOf(fresh))).status).toBe(200);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toHaveLength(2);
  });

  it("still lets resend re-arm an expired invitation", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    await expire(created.id);

    const resent = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${created.id}/resend`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(resent.status).toBe(200);
    expect(invitationOf(resent).status).toBe("pending");
    expect((await accept(await signIn("second-adult"), tokenOf(invitationOf(resent)))).status).toBe(
      200,
    );
  });
});

describe("accepting a guardian invitation", () => {
  it("rebinds only the exact guardian relationship the owner confirmed", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");

    // The manager writes the parent onto the child by hand FIRST — a
    // placeholder Person with no account, which is all the manual path can mint.
    const manual = await attachGuardian(cookie, participantId, {
      displayName: SECOND_ADULT_NAME,
      relationship: "parent",
    });
    expect(manual.status).toBe(201);
    const placeholderEdgeId = (json(manual) as { guardian: { guardianId: string } }).guardian
      .guardianId;

    // ... then invites the same parent to the same child with the same label.
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's dad",
        participantId,
        relationship: "parent",
        replacesGuardianRelationshipId: placeholderEdgeId,
      }),
    );
    expect((await accept(secondCookie, tokenOf(created))).status).toBe(200);

    // ONE active edge, now owned by the real adult identity — so the roster
    // shows one guardian, and the accepting parent actually holds the edge.
    const edges = await config.db
      .prepare(
        "SELECT id, guardian_person_id, relationship, status FROM guardian_relationships WHERE participant_id = ?",
      )
      .all([participantId]);
    expect(edges).toEqual([
      {
        id: placeholderEdgeId,
        guardian_person_id: SECOND_PERSON_ID,
        relationship: "parent",
        status: "active",
      },
    ]);

    const roster = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(roster[0]?.guardians).toHaveLength(1);
    expect(roster[0]?.guardians[0]?.displayName).toBe(SECOND_ADULT_NAME);
  });

  it("adds a guardian when the roster's existing one is a different person", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");

    expect(
      (
        await attachGuardian(cookie, participantId, {
          displayName: "Alex Guardian",
          relationship: "parent",
        })
      ).status,
    ).toBe(201);

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's aunt",
        participantId,
        relationship: "parent",
      }),
    );
    expect((await accept(secondCookie, tokenOf(created))).status).toBe(200);

    // Two genuinely different people, so two edges — the dedupe never merges
    // guardians who do not share an identity.
    const roster = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(roster[0]?.guardians.map((guardian) => guardian.displayName)).toEqual([
      "Alex Guardian",
      SECOND_ADULT_NAME,
    ]);
  });

  it("preserves an unselected same-name placeholder instead of treating a name as identity", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");
    expect(
      (
        await attachGuardian(cookie, participantId, {
          displayName: SECOND_ADULT_NAME,
          relationship: "parent",
        })
      ).status,
    ).toBe(201);

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "same display name",
        participantId,
        relationship: "parent",
      }),
    );
    expect((await accept(secondCookie, tokenOf(created))).status).toBe(200);

    expect(
      await config.db
        .prepare("SELECT guardian_person_id FROM guardian_relationships WHERE participant_id = ?")
        .all([participantId]),
    ).toHaveLength(2);
  });

  it("rechecks an exact placeholder before granting either team or child access", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");
    const manual = await attachGuardian(cookie, participantId, {
      displayName: "Confirmed placeholder",
      relationship: "parent",
    });
    const relationshipId = (json(manual) as { guardian: { guardianId: string } }).guardian
      .guardianId;
    const edge = (await config.db
      .prepare("SELECT guardian_person_id FROM guardian_relationships WHERE id = ?")
      .get([relationshipId])) as { guardian_person_id: string };
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "confirmed placeholder",
        participantId,
        relationship: "parent",
        replacesGuardianRelationshipId: relationshipId,
      }),
    );

    const nowIso = new Date().toISOString();
    await config.db
      .prepare(
        "INSERT INTO accounts (id, person_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .run(["account_placeholder_claimed", edge.guardian_person_id, nowIso, nowIso]);

    expect((await accept(secondCookie, tokenOf(created))).status).toBe(404);
    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toEqual([]);
    expect(
      await config.db
        .prepare("SELECT guardian_person_id, status FROM guardian_relationships WHERE id = ?")
        .get([relationshipId]),
    ).toEqual({
      guardian_person_id: edge.guardian_person_id,
      status: "active",
    });
  });

  it("stays idempotent when the same adult accepts a second invitation for one child", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");

    for (const label of ["first ask", "second ask"]) {
      const created = invitationOf(
        await invite(cookie, teamId, {
          invitedRole: "adult",
          inviteeLabel: label,
          participantId,
          relationship: "parent",
        }),
      );
      expect((await accept(secondCookie, tokenOf(created))).status).toBe(200);
    }

    expect(
      await config.db
        .prepare("SELECT id FROM guardian_relationships WHERE participant_id = ?")
        .all([participantId]),
    ).toHaveLength(1);
  });
});

describe("roster invitation status", () => {
  it("counts a child's guardian invitations without leaking the label or the link", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const secondCookie = await signIn("second-adult");

    const before = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(before[0]?.guardianInvitations).toEqual({
      pending: 0,
      expired: 0,
      accepted: 0,
    });

    const pending = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's dad",
        participantId,
        relationship: "parent",
      }),
    );
    const withPending = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(withPending[0]?.guardianInvitations).toEqual({
      pending: 1,
      expired: 0,
      accepted: 0,
    });

    await expire(pending.id);
    const withExpired = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(withExpired[0]?.guardianInvitations).toEqual({
      pending: 0,
      expired: 1,
      accepted: 0,
    });

    const acceptedInvite = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's aunt",
        participantId,
        relationship: "caregiver",
      }),
    );
    expect((await accept(secondCookie, tokenOf(acceptedInvite))).status).toBe(200);

    const rosterRead = await readRoster(cookie, teamId, seasonId);
    expect(rosterOf(rosterRead)[0]?.guardianInvitations).toEqual({
      pending: 0,
      expired: 1,
      accepted: 1,
    });

    // A team-scoped invitation that names NO child is not counted against one.
    const teamWide = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "team manager",
      }),
    );
    expect(teamWide.status).toBe("pending");
    expect(rosterOf(await readRoster(cookie, teamId, seasonId))[0]?.guardianInvitations).toEqual({
      pending: 0,
      expired: 1,
      accepted: 1,
    });

    // PRIVACY: the roster projection carries counts only — never the inviter's
    // wording for the invitee (which quotes a child), never a token or a link.
    const scanned = withoutOpaqueIds(rosterRead.body.toLowerCase());
    for (const forbidden of [
      "dad",
      "aunt",
      "invitee",
      "label",
      "token",
      "invite#",
      "invitation_",
    ]) {
      expect(scanned).not.toContain(forbidden);
    }
  });
});

describe("invitation authorization boundaries", () => {
  it("requires authentication on every invitation route", async () => {
    const responses = [
      await app.handle("POST", "/api/teams/missing/invitations", {
        headers: sameOrigin,
        body: { invitedRole: "adult", inviteeLabel: "anyone" },
      }),
      await app.handle("POST", "/api/teams/missing/invitations/missing/resend", {
        headers: sameOrigin,
      }),
      await app.handle("POST", "/api/teams/missing/invitations/missing/revoke", {
        headers: sameOrigin,
      }),
      await app.handle("GET", "/api/teams/missing/invitations"),
      await app.handle("POST", "/api/invitations/accept", {
        headers: sameOrigin,
        body: { token: "0".repeat(64) },
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });

  it("hides another owner's team behind 404 on every owner-scoped route", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const created = invitationOf(
      await invite(ownerCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const secondCookie = await signIn("second-adult");

    const responses = [
      await invite(secondCookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "intruder",
      }),
      await app.handle("POST", `/api/teams/${teamId}/invitations/${created.id}/resend`, {
        headers: { ...sameOrigin, cookie: secondCookie },
      }),
      await app.handle("POST", `/api/teams/${teamId}/invitations/${created.id}/revoke`, {
        headers: { ...sameOrigin, cookie: secondCookie },
      }),
      await app.handle("GET", `/api/teams/${teamId}/invitations`, {
        headers: { cookie: secondCookie },
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }
    expect(
      await config.db.prepare("SELECT status FROM invitations WHERE id = ?").all([created.id]),
    ).toEqual([{ status: "pending" }]);
  });

  it("refuses to resend or revoke another team's invitation, even for the same owner", async () => {
    const cookie = await signIn();
    const { teamId: teamOne } = await createTeamAndSeason(cookie);
    // A SECOND team the same owner manages: `manageableActiveTeam` passes for
    // both, so the invitation lookup's own team clause is the only thing
    // keeping team two's routes off team one's invitation.
    const teamTwo = await createTeam(cookie, "Invite Hawks");
    const created = invitationOf(
      await invite(cookie, teamOne, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );
    const before = await config.db
      .prepare("SELECT * FROM invitations WHERE id = ?")
      .get([created.id]);

    for (const action of ["resend", "revoke"]) {
      const response = await app.handle(
        "POST",
        `/api/teams/${teamTwo}/invitations/${created.id}/${action}`,
        { headers: { ...sameOrigin, cookie } },
      );
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "invitation not found" });
    }

    // Untouched down to the token hash and the expiry — neither rotated nor
    // revoked through the wrong team's route.
    expect(
      await config.db.prepare("SELECT * FROM invitations WHERE id = ?").get([created.id]),
    ).toEqual(before);
    // ... and the original link still works on the team it belongs to.
    expect((await accept(await signIn("second-adult"), tokenOf(created))).status).toBe(200);
  });

  it("stops honoring a live session once the account or the person is deactivated", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const readTeam = () => app.handle("GET", `/api/teams/${teamId}`, { headers: { cookie } });
    expect((await readTeam()).status).toBe(200);

    // The SESSION stays valid throughout — only the identity behind it is
    // deactivated, which every authorized route must notice.
    await config.db
      .prepare("UPDATE accounts SET status = 'revoked' WHERE person_id = ?")
      .run([DEV_PERSON_ID]);
    const withRevokedAccount = await readTeam();
    expect(withRevokedAccount.status).toBe(401);
    expect(json(withRevokedAccount)).toEqual({
      error: "authentication required",
    });
    const mutation = await invite(cookie, teamId, {
      invitedRole: "adult",
      inviteeLabel: "after deactivation",
    });
    expect(mutation.status).toBe(401);

    await config.db
      .prepare("UPDATE accounts SET status = 'active' WHERE person_id = ?")
      .run([DEV_PERSON_ID]);
    expect((await readTeam()).status).toBe(200);

    // Deactivating the PERSON behind an active account is refused just as hard.
    await config.db
      .prepare("UPDATE people SET status = 'revoked' WHERE id = ?")
      .run([DEV_PERSON_ID]);
    const withRevokedPerson = await readTeam();
    expect(withRevokedPerson.status).toBe(401);
    expect(json(withRevokedPerson)).toEqual({
      error: "authentication required",
    });
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });

  it("refuses cross-site and metadata-less mutations before touching state", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Maya's dad",
      }),
    );

    for (const headers of [{ "sec-fetch-site": "cross-site", cookie }, { cookie }]) {
      const responses = [
        await app.handle("POST", `/api/teams/${teamId}/invitations`, {
          headers,
          body: { invitedRole: "adult", inviteeLabel: "csrf probe" },
        }),
        await app.handle("POST", `/api/teams/${teamId}/invitations/${created.id}/resend`, {
          headers,
        }),
        await app.handle("POST", `/api/teams/${teamId}/invitations/${created.id}/revoke`, {
          headers,
        }),
        await app.handle("POST", "/api/invitations/accept", {
          headers,
          body: { token: "0".repeat(64) },
        }),
      ];
      for (const response of responses) expect(response.status).toBe(403);
    }
    expect(await config.db.prepare("SELECT status FROM invitations").all()).toEqual([
      { status: "pending" },
    ]);
  });
});

describe("delivery privacy", () => {
  it("keeps child names and invitee labels out of every delivery payload", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const participantId = await addChild(cookie, teamId, seasonId);
    const before = devInviteDelivery.deliveries.length;

    const created = invitationOf(
      await invite(cookie, teamId, {
        invitedRole: "adult",
        inviteeLabel: "Rowan's dad",
        participantId,
        relationship: "parent",
      }),
    );
    await app.handle("POST", `/api/teams/${teamId}/invitations/${created.id}/resend`, {
      headers: { ...sameOrigin, cookie },
    });

    const delivered = devInviteDelivery.deliveries.slice(before);
    expect(delivered).toHaveLength(2);
    for (const payload of delivered) {
      expect(Object.keys(payload).toSorted()).toEqual([
        "idempotencyKey",
        "invitationId",
        "inviteUrl",
        "invitedRole",
        "inviterDisplayName",
        "recipient",
        "teamName",
      ]);
    }
    const serialized = withoutOpaqueIds(JSON.stringify(delivered).toLowerCase());
    for (const forbidden of ["rowan", "dad", "participant", "birth", "label"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
