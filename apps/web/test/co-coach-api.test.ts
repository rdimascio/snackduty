import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const [{ default: config }, { hashInviteToken }] = await Promise.all([
  import("../lesto.app"),
  import("../app/lib/server/invitations"),
]);
const SECOND_PERSON_ID = "person_dev_second_adult";
const OWNER_PERSON_ID = "person_dev_adult";

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function createTeam(cookie: string, name: string): Promise<string> {
  const response = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name },
  });
  expect(response.status).toBe(201);
  return (json(response) as { team: { id: string } }).team.id;
}

function createSeason(cookie: string, teamId: string, label: string) {
  return app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label,
      startDate: "2026-09-01",
      endDate: "2026-11-15",
      timeZone: "America/Los_Angeles",
    },
  });
}

function addChild(cookie: string, teamId: string, seasonId: string) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body: { displayName: "Casey Player", birthDate: "2018-04-09" },
  });
}

function coCoach(
  requester: typeof app,
  cookie: string,
  teamId: string,
  personId: string,
  action: "grant" | "revoke",
) {
  return requester.handle(
    "POST",
    `/api/teams/${teamId}/adult-members/${personId}/co-coach/${action}`,
    { headers: { ...sameOrigin, cookie } },
  );
}

async function seedAdultMembership(
  teamId: string,
  role: "owner" | "coach" | "adult",
  status = "active",
  personId = SECOND_PERSON_ID,
) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run([`adult_membership_${crypto.randomUUID()}`, teamId, personId, role, status, now, now]);
}

async function seedActiveAdult(personId: string, accountId: string, displayName: string) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run([personId, displayName, now, now]);
  await config.db
    .prepare(
      "INSERT INTO accounts (id, person_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run([accountId, personId, now, now]);
}

async function seedGuardian(participantId: string) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES (?, ?, ?, 'parent', 'active', ?, ?, ?)",
    )
    .run([
      `guardian_relationship_${crypto.randomUUID()}`,
      SECOND_PERSON_ID,
      participantId,
      JSON.stringify(["participant.read", "participant.manage"]),
      now,
      now,
    ]);
}

async function seedAcceptedAdultInvitation(teamId: string, token: string) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO invitations (id, team_id, invited_role, participant_id, relationship, invitee_label, token_hash, status, created_by_person_id, accepted_by_person_id, created_at, updated_at, expires_at) VALUES (?, ?, 'adult', NULL, NULL, 'accepted adult', ?, 'accepted', ?, ?, ?, ?, ?)",
    )
    .run([
      `invitation_${crypto.randomUUID()}`,
      teamId,
      await hashInviteToken(token),
      OWNER_PERSON_ID,
      SECOND_PERSON_ID,
      now,
      now,
      new Date(Date.now() + 86_400_000).toISOString(),
    ]);
}

describe("owner-authorized co-coach capabilities", () => {
  it("persists a grant across app startup and keeps invitations owner-only", async () => {
    const ownerCookie = await signIn();
    const coachCookie = await signIn("second-adult");
    const teamId = await createTeam(ownerCookie, "Falcons");
    await seedAdultMembership(teamId, "adult");

    for (const action of ["grant", "revoke"] as const) {
      const signedOut = await coCoach(app, "", teamId, SECOND_PERSON_ID, action);
      expect(signedOut.status).toBe(401);
      expect(json(signedOut)).toEqual({ error: "authentication required" });
    }

    const granted = await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant");
    expect(granted.status).toBe(200);
    expect(json(granted)).toEqual({
      membership: { personId: SECOND_PERSON_ID, role: "coach", status: "active" },
    });

    expect(
      await config.db
        .prepare("SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ?")
        .all([teamId, SECOND_PERSON_ID]),
    ).toEqual([{ role: "coach", status: "active" }]);

    // A second createApp call runs the migration-backed startup path against
    // the same database. The stored role, rather than process memory, grants
    // the coach operational management after restart.
    const restartedApp = await createApp(config);
    expect((await createSeasonWith(restartedApp, coachCookie, teamId, "Restarted")).status).toBe(
      201,
    );

    const deniedInvitation = await restartedApp.handle("POST", `/api/teams/${teamId}/invitations`, {
      headers: { ...sameOrigin, cookie: coachCookie },
      body: { invitedRole: "owner", inviteeLabel: "Privilege escalation" },
    });
    expect(deniedInvitation.status).toBe(404);
    expect(json(deniedInvitation)).toEqual({ error: "team not found" });
    expect(
      (
        await restartedApp.handle("GET", `/api/teams/${teamId}/invitations`, {
          headers: { cookie: coachCookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (await coCoach(restartedApp, coachCookie, teamId, SECOND_PERSON_ID, "revoke")).status,
    ).toBe(404);
    expect(await config.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });

  it("lets an owner-member delegate while keeping the invited role set closed", async () => {
    const creatorCookie = await signIn();
    const ownerMemberCookie = await signIn("second-adult");
    const teamId = await createTeam(creatorCookie, "Falcons");
    await seedAdultMembership(teamId, "owner");

    const thirdPersonId = "person_existing_adult";
    await seedActiveAdult(thirdPersonId, "account_existing_adult", "Existing Adult");
    await seedAdultMembership(teamId, "adult", "active", thirdPersonId);

    const granted = await coCoach(app, ownerMemberCookie, teamId, thirdPersonId, "grant");
    expect(granted.status).toBe(200);
    expect(json(granted)).toMatchObject({ membership: { personId: thirdPersonId, role: "coach" } });

    const invitation = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
      headers: { ...sameOrigin, cookie: ownerMemberCookie },
      body: { invitedRole: "adult", inviteeLabel: "Existing parent" },
    });
    expect(invitation.status).toBe(201);

    await expect(
      app.handle("POST", `/api/teams/${teamId}/invitations`, {
        headers: { ...sameOrigin, cookie: ownerMemberCookie },
        body: { invitedRole: "coach", inviteeLabel: "Unverified coach" },
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    expect(
      await config.db
        .prepare("SELECT role FROM adult_memberships WHERE team_id = ? AND person_id = ?")
        .all([teamId, thirdPersonId]),
    ).toEqual([{ role: "coach" }]);
  });

  it("downgrades every duplicate coach row and a stale accept cannot restore coaching", async () => {
    const ownerCookie = await signIn();
    const coachCookie = await signIn("second-adult");
    const teamId = await createTeam(ownerCookie, "Falcons");
    await seedAdultMembership(teamId, "adult");
    await seedAdultMembership(teamId, "adult");
    const acceptedToken = "previously-accepted-adult-token";
    await seedAcceptedAdultInvitation(teamId, acceptedToken);

    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant")).status).toBe(200);
    expect(
      await config.db
        .prepare(
          "SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ? ORDER BY id",
        )
        .all([teamId, SECOND_PERSON_ID]),
    ).toEqual([
      { role: "coach", status: "active" },
      { role: "coach", status: "active" },
    ]);

    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "revoke")).status).toBe(200);
    const retried = await app.handle("POST", "/api/invitations/accept", {
      headers: { ...sameOrigin, cookie: coachCookie },
      body: { token: acceptedToken },
    });
    expect(retried.status).toBe(200);
    expect(json(retried)).toMatchObject({ membership: { role: "adult" } });
    expect(
      await config.db
        .prepare(
          "SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ? ORDER BY id",
        )
        .all([teamId, SECOND_PERSON_ID]),
    ).toEqual([
      { role: "adult", status: "active" },
      { role: "adult", status: "active" },
    ]);
    expect((await createSeason(coachCookie, teamId, "Still revoked")).status).toBe(404);
  });

  it("keeps coaching and guardian rights additive and team-scoped through revoke", async () => {
    const ownerCookie = await signIn();
    const adultCookie = await signIn("second-adult");
    const coachedTeamId = await createTeam(ownerCookie, "Coached Falcons");
    const familyTeamId = await createTeam(ownerCookie, "Family Falcons");
    const coachedSeason = await createSeason(ownerCookie, coachedTeamId, "Coached season");
    const familySeason = await createSeason(ownerCookie, familyTeamId, "Family season");
    const coachedSeasonId = (json(coachedSeason) as { season: { id: string } }).season.id;
    const familySeasonId = (json(familySeason) as { season: { id: string } }).season.id;
    const coachedChild = await addChild(ownerCookie, coachedTeamId, coachedSeasonId);
    const child = await addChild(ownerCookie, familyTeamId, familySeasonId);
    const coachedParticipantId = (json(coachedChild) as { participant: { participantId: string } })
      .participant.participantId;
    const participantId = (json(child) as { participant: { participantId: string } }).participant
      .participantId;

    await seedAdultMembership(coachedTeamId, "adult");
    await seedAdultMembership(familyTeamId, "adult");
    await seedGuardian(coachedParticipantId);
    await seedGuardian(participantId);

    expect((await coCoach(app, ownerCookie, coachedTeamId, SECOND_PERSON_ID, "grant")).status).toBe(
      200,
    );
    expect((await createSeason(adultCookie, coachedTeamId, "Coach-created")).status).toBe(201);

    // Possessing the other team's id does not turn the coaching grant into a
    // global role, and a coach cannot delegate on either team.
    expect((await createSeason(adultCookie, familyTeamId, "Cross-team attempt")).status).toBe(404);
    expect((await coCoach(app, adultCookie, familyTeamId, SECOND_PERSON_ID, "grant")).status).toBe(
      404,
    );

    const roles = await config.db
      .prepare("SELECT team_id, role FROM adult_memberships WHERE person_id = ? ORDER BY team_id")
      .all([SECOND_PERSON_ID]);
    expect(roles).toEqual(
      [
        { team_id: coachedTeamId, role: "coach" },
        { team_id: familyTeamId, role: "adult" },
      ].toSorted((left, right) => left.team_id.localeCompare(right.team_id)),
    );

    const familyRosterBefore = await app.handle(
      "GET",
      `/api/teams/${familyTeamId}/seasons/${familySeasonId}/roster`,
      { headers: { cookie: adultCookie } },
    );
    expect(familyRosterBefore.status).toBe(200);
    expect(json(familyRosterBefore)).toMatchObject({
      roster: [
        {
          participantId,
          displayName: "Casey Player",
          birthDate: "2018-04-09",
          guardians: [{ displayName: "Second Development Adult", relationship: "parent" }],
        },
      ],
    });

    expect(
      (await coCoach(app, ownerCookie, coachedTeamId, SECOND_PERSON_ID, "revoke")).status,
    ).toBe(200);
    expect((await createSeason(adultCookie, coachedTeamId, "After revoke")).status).toBe(404);
    const coachedRoster = await app.handle(
      "GET",
      `/api/teams/${coachedTeamId}/seasons/${coachedSeasonId}/roster`,
      { headers: { cookie: adultCookie } },
    );
    expect(coachedRoster.status).toBe(200);
    expect(json(coachedRoster)).toMatchObject({
      roster: [
        {
          participantId: coachedParticipantId,
          birthDate: "2018-04-09",
          guardians: [{ displayName: "Second Development Adult" }],
        },
      ],
    });

    const familyRosterAfter = await app.handle(
      "GET",
      `/api/teams/${familyTeamId}/seasons/${familySeasonId}/roster`,
      { headers: { cookie: adultCookie } },
    );
    expect(json(familyRosterAfter)).toEqual(json(familyRosterBefore));
    expect(
      await config.db
        .prepare("SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ?")
        .all([coachedTeamId, SECOND_PERSON_ID]),
    ).toEqual([{ role: "adult", status: "active" }]);
  });

  it("requires an active adult member and never changes an owner role", async () => {
    const ownerCookie = await signIn();
    await signIn("second-adult");
    const teamId = await createTeam(ownerCookie, "Falcons");

    const missing = await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant");
    expect(missing.status).toBe(404);
    expect(json(missing)).toEqual({ error: "adult team member not found" });

    await seedAdultMembership(teamId, "adult", "revoked");
    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant")).status).toBe(404);

    await seedAdultMembership(teamId, "owner");
    await seedAdultMembership(teamId, "adult");
    const ownerTarget = await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "revoke");
    expect(ownerTarget.status).toBe(409);
    expect(json(ownerTarget)).toEqual({ error: "team owner role cannot change" });
    expect(
      await config.db
        .prepare(
          "SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ? ORDER BY status, role",
        )
        .all([teamId, SECOND_PERSON_ID]),
    ).toEqual([
      { role: "adult", status: "active" },
      { role: "owner", status: "active" },
      { role: "adult", status: "revoked" },
    ]);

    const now = new Date().toISOString();
    await config.db
      .prepare(
        "INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'adult', 'active', ?, ?)",
      )
      .run([`adult_membership_${crypto.randomUUID()}`, teamId, OWNER_PERSON_ID, now, now]);
    expect((await coCoach(app, ownerCookie, teamId, OWNER_PERSON_ID, "revoke")).status).toBe(409);
    expect(
      await config.db
        .prepare("SELECT role FROM adult_memberships WHERE team_id = ? AND person_id = ?")
        .all([teamId, OWNER_PERSON_ID]),
    ).toEqual([{ role: "adult" }]);
  });

  it("refuses a deactivated adult and leaves unsupported role rows inert", async () => {
    const ownerCookie = await signIn();
    await signIn("second-adult");
    const teamId = await createTeam(ownerCookie, "Falcons");
    await seedAdultMembership(teamId, "adult");
    const now = new Date().toISOString();
    await config.db
      .prepare(
        "INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'future-role', 'active', ?, ?)",
      )
      .run([`adult_membership_${crypto.randomUUID()}`, teamId, SECOND_PERSON_ID, now, now]);
    await config.db
      .prepare("UPDATE accounts SET status = 'inactive' WHERE person_id = ?")
      .run([SECOND_PERSON_ID]);

    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant")).status).toBe(404);
    await config.db
      .prepare("UPDATE accounts SET status = 'active' WHERE person_id = ?")
      .run([SECOND_PERSON_ID]);
    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "grant")).status).toBe(200);

    await config.db
      .prepare("UPDATE accounts SET status = 'inactive' WHERE person_id = ?")
      .run([SECOND_PERSON_ID]);
    expect((await coCoach(app, ownerCookie, teamId, SECOND_PERSON_ID, "revoke")).status).toBe(200);
    await config.db
      .prepare("UPDATE accounts SET status = 'active' WHERE person_id = ?")
      .run([SECOND_PERSON_ID]);

    expect(
      await config.db
        .prepare(
          "SELECT role, status FROM adult_memberships WHERE team_id = ? AND person_id = ? ORDER BY role",
        )
        .all([teamId, SECOND_PERSON_ID]),
    ).toEqual([
      { role: "adult", status: "active" },
      { role: "future-role", status: "active" },
    ]);
    expect((await createSeason(await signIn("second-adult"), teamId, "No restore")).status).toBe(
      404,
    );
  });
});

function createSeasonWith(requester: typeof app, cookie: string, teamId: string, label: string) {
  return requester.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label,
      startDate: "2026-09-01",
      endDate: "2026-11-15",
      timeZone: "America/Los_Angeles",
    },
  });
}
