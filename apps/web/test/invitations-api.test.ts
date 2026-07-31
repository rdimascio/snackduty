import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config, devInviteDelivery } = await import("../lesto.app");

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

async function createTeamAndSeason(cookie: string): Promise<{ teamId: string; seasonId: string }> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Invite Falcons" },
  });
  expect(createdTeam.status).toBe(201);
  const teamId = (json(createdTeam) as { team: { id: string } }).team.id;

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

  return { teamId, seasonId: (json(createdSeason) as { season: { id: string } }).season.id };
}

async function addChild(cookie: string, teamId: string, seasonId: string): Promise<string> {
  const added = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body: { displayName: "Rowan Child", birthDate: "2018-04-09" },
  });
  expect(added.status).toBe(201);
  return (json(added) as { participant: { participantId: string } }).participant.participantId;
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

function tokenOf(invitation: InvitationBody): string {
  const url = invitation.inviteUrl ?? "";
  expect(url).toStartWith("/invite/");
  return url.slice("/invite/".length);
}

describe("generalized authentication", () => {
  it("lets the second persona sign in and hides non-owned teams behind 404", async () => {
    const ownerCookie = await signIn();
    const { teamId } = await createTeamAndSeason(ownerCookie);
    const secondCookie = await signIn("second-adult");

    const ownList = await app.handle("GET", "/api/teams", { headers: { cookie: secondCookie } });
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

describe("invitation lifecycle", () => {
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
        invitationId: invitation.id,
        teamName: "Invite Falcons",
        inviterDisplayName: "Development Adult",
        invitedRole: "adult",
        inviteUrl: `/invite/${token}`,
      },
    ]);
  });

  it("answers 409 while an invitation with the same label is pending", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);

    expect(
      (await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" })).status,
    ).toBe(201);

    const duplicate = await invite(cookie, teamId, {
      invitedRole: "owner",
      inviteeLabel: "Maya's dad",
    });
    expect(duplicate.status).toBe(409);
    expect(json(duplicate)).toEqual({ error: "invitation already pending" });

    expect(
      (await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's mom" })).status,
    ).toBe(201);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toHaveLength(2);
  });

  it("lists every invitation state with a link only for pending ones", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const pending = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "stays pending" }),
    );
    const revoked = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "gets revoked" }),
    );
    await app.handle("POST", `/api/teams/${teamId}/invitations/${revoked.id}/revoke`, {
      headers: { ...sameOrigin, cookie },
    });
    const acceptedInvite = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "gets accepted" }),
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
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
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
      invitation: { id: created.id, invitedRole: "adult", status: "accepted" },
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
    for (const forbidden of ["rowan", "dad", "participant_", "person_"]) {
      expect(accepted.body.toLowerCase()).not.toContain(forbidden);
    }

    expect(
      await config.db
        .prepare("SELECT team_id, person_id, role, status FROM adult_memberships")
        .all(),
    ).toEqual([{ team_id: teamId, person_id: SECOND_PERSON_ID, role: "adult", status: "active" }]);
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

  it("repeat accept is idempotent for the same adult and conflicts for another", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
    );
    const token = tokenOf(created);

    const first = await accept(secondCookie, token);
    expect(first.status).toBe(200);

    const again = await accept(secondCookie, token);
    expect(again.status).toBe(200);
    expect(json(again)).toEqual(json(first));
    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toHaveLength(1);

    const other = await accept(cookie, token);
    expect(other.status).toBe(409);
    expect(json(other)).toEqual({ error: "invitation already accepted" });
    expect(other.body).not.toContain(SECOND_PERSON_ID);
  });

  it("an existing member accepts another invitation without a duplicate membership", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const first = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "first invite" }),
    );
    const second = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "second invite" }),
    );

    expect((await accept(secondCookie, tokenOf(first))).status).toBe(200);
    expect((await accept(secondCookie, tokenOf(second))).status).toBe(200);

    expect(await config.db.prepare("SELECT id FROM adult_memberships").all()).toHaveLength(1);
    expect(
      await config.db.prepare("SELECT status FROM invitations ORDER BY created_at, id").all(),
    ).toEqual([{ status: "accepted" }, { status: "accepted" }]);
  });

  it("revokes pending invitations, refuses accepted ones, and re-revokes idempotently", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
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
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "accepted invite" }),
    );
    expect((await accept(secondCookie, tokenOf(acceptedInvite))).status).toBe(200);
    const revokeAccepted = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${acceptedInvite.id}/revoke`,
      { headers: { ...sameOrigin, cookie } },
    );
    expect(revokeAccepted.status).toBe(409);
    expect(json(revokeAccepted)).toEqual({ error: "invitation already accepted" });
  });

  it("hides expired tokens behind 404 until a resend refreshes the expiry", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const secondCookie = await signIn("second-adult");

    const created = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
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
      await invite(ownerCookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
    );
    const secondCookie = await signIn("second-adult");

    const responses = [
      await invite(secondCookie, teamId, { invitedRole: "adult", inviteeLabel: "intruder" }),
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

  it("refuses cross-site and metadata-less mutations before touching state", async () => {
    const cookie = await signIn();
    const { teamId } = await createTeamAndSeason(cookie);
    const created = invitationOf(
      await invite(cookie, teamId, { invitedRole: "adult", inviteeLabel: "Maya's dad" }),
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
        "invitationId",
        "inviteUrl",
        "invitedRole",
        "inviterDisplayName",
        "teamName",
      ]);
    }
    const serialized = JSON.stringify(delivered).toLowerCase();
    for (const forbidden of ["rowan", "dad", "participant", "birth", "label"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
