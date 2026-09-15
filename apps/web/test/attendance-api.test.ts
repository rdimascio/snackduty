import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("./support/application").then((module) =>
  module.testApplication(),
);

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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

interface Fixture {
  teamId: string;
  seasonId: string;
  childA: string;
  childB: string;
  occurrenceId: string;
}

/** Team, season, two children, and one future once-event, all over the API. */
async function buildFixture(cookie: string): Promise<Fixture> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Attendance Falcons" },
  });
  const teamId = (json(createdTeam) as { team: { id: string } }).team.id;

  const createdSeason = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2030",
      startDate: "2030-03-01",
      endDate: "2030-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;

  const children: string[] = [];
  for (const displayName of ["Casey Kid", "Robin Kid"]) {
    const added = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        headers: { ...sameOrigin, cookie },
        body: { displayName },
      },
    );
    expect(added.status).toBe(201);
    children.push(
      (json(added) as { participant: { participantId: string } }).participant.participantId,
    );
  }

  const createdEvent = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/events`, {
    headers: { ...sameOrigin, cookie },
    body: {
      title: "Practice",
      kind: "practice",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "17:00",
        durationMinutes: 60,
        frequency: "once",
        startDate: "2030-05-01",
      },
    },
  });
  expect(createdEvent.status).toBe(201);
  const occurrenceId = (json(createdEvent) as { occurrences: { id: string }[] }).occurrences[0]?.id;
  expect(typeof occurrenceId).toBe("string");

  return {
    teamId,
    seasonId,
    childA: children[0] ?? "",
    childB: children[1] ?? "",
    occurrenceId: occurrenceId ?? "",
  };
}

/** The second adult joins as a member AND becomes child A's guardian, via the real invite flow. */
async function joinAsGuardianOfChildA(ownerCookie: string, fixture: Fixture): Promise<string> {
  const guardianCookie = await signIn("second-adult");
  const invited = await app.handle("POST", `/api/teams/${fixture.teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "Casey's parent",
      participantId: fixture.childA,
      relationship: "parent",
      recipientBinding: { kind: "confirmed_person", personId: SECOND_PERSON_ID },
    },
  });
  expect(invited.status).toBe(201);
  const inviteUrl = (json(invited) as { invitation: { inviteUrl: string } }).invitation.inviteUrl;
  const token = inviteUrl.split("#")[1] ?? "";

  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: guardianCookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);
  return guardianCookie;
}

/**
 * The second adult joins as a plain team member holding NO guardian edge — the
 * treasurer, the assistant coach, the parent whose own child left. They may
 * READ the team; they guard nobody, so no child's attendance is theirs.
 */
async function joinAsMemberWithoutGuardianEdge(
  ownerCookie: string,
  fixture: Fixture,
): Promise<string> {
  const memberCookie = await signIn("second-adult");
  const invited = await app.handle("POST", `/api/teams/${fixture.teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "the team treasurer",
      recipientBinding: { kind: "confirmed_person", personId: SECOND_PERSON_ID },
    },
  });
  expect(invited.status).toBe(201);
  const token =
    (json(invited) as { invitation: { inviteUrl: string } }).invitation.inviteUrl.split("#")[1] ??
    "";

  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: memberCookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

function record(cookie: string, fixture: Fixture, participantId: string, status: string) {
  return app.handle(
    "POST",
    `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/attendance`,
    {
      headers: { ...sameOrigin, cookie },
      body: { participantId, status },
    },
  );
}

function read(cookie: string, fixture: Fixture) {
  return app.handle(
    "GET",
    `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/attendance`,
    {
      headers: { cookie },
    },
  );
}

describe("recording attendance", () => {
  it("lets a manager record any rostered child, upserting one row per child", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);

    const first = await record(cookie, fixture, fixture.childA, "yes");
    expect(first.status).toBe(200);
    expect(json(first)).toEqual({ attendance: { participantId: fixture.childA, status: "yes" } });

    const changed = await record(cookie, fixture, fixture.childA, "no");
    expect(changed.status).toBe(200);
    expect(json(changed)).toEqual({ attendance: { participantId: fixture.childA, status: "no" } });

    const rows = await config.db
      .prepare("SELECT participant_id, status FROM event_attendance")
      .all();
    expect(rows).toEqual([{ participant_id: fixture.childA, status: "no" }]);
  });

  it("lets a guardian record their own child and hides everyone else's", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);
    const guardianCookie = await joinAsGuardianOfChildA(ownerCookie, fixture);

    const own = await record(guardianCookie, fixture, fixture.childA, "maybe");
    expect(own.status).toBe(200);
    expect(json(own)).toEqual({ attendance: { participantId: fixture.childA, status: "maybe" } });

    // Child B is on the roster the guardian can READ — but attendance
    // authority is a guardian edge, and its absence hides like nonexistence.
    const otherChild = await record(guardianCookie, fixture, fixture.childB, "yes");
    expect(otherChild.status).toBe(404);
    const unknownChild = await record(guardianCookie, fixture, "participant_missing", "yes");
    expect(unknownChild.status).toBe(404);
    expect(otherChild.body).toBe(unknownChild.body);

    const rows = await config.db
      .prepare("SELECT participant_id, status FROM event_attendance")
      .all();
    expect(rows).toEqual([{ participant_id: fixture.childA, status: "maybe" }]);
  });

  it("hides the whole surface from strangers and requires authentication", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);

    const signedOut = await record("", fixture, fixture.childA, "yes");
    expect(signedOut.status).toBe(401);

    const strangerCookie = await signIn("second-adult");
    const stranger = await record(strangerCookie, fixture, fixture.childA, "yes");
    expect(stranger.status).toBe(404);
    expect(json(stranger)).toEqual({ error: "team not found" });

    const crossSite = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/attendance`,
      {
        headers: { "sec-fetch-site": "cross-site", cookie: ownerCookie },
        body: { participantId: fixture.childA, status: "yes" },
      },
    );
    expect(crossSite.status).toBe(403);

    expect(await config.db.prepare("SELECT id FROM event_attendance").all()).toEqual([]);
  });

  it("refuses a cancelled occurrence and hides unrosterd or foreign targets", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);

    const unknownOccurrence = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/event_occurrence_missing/attendance`,
      {
        headers: { ...sameOrigin, cookie: ownerCookie },
        body: { participantId: fixture.childA, status: "yes" },
      },
    );
    expect(unknownOccurrence.status).toBe(404);
    expect(json(unknownOccurrence)).toEqual({ error: "event not found" });

    const cancelled = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceId}/cancel`,
      { headers: { ...sameOrigin, cookie: ownerCookie }, body: { reason: "Rained out" } },
    );
    expect(cancelled.status).toBe(200);

    const onCancelled = await record(ownerCookie, fixture, fixture.childA, "yes");
    expect(onCancelled.status).toBe(409);
    expect(json(onCancelled)).toEqual({ error: "event occurrence is cancelled" });
    expect(await config.db.prepare("SELECT id FROM event_attendance").all()).toEqual([]);
  });
});

describe("reading attendance", () => {
  it("scopes entries by role: managers see all, guardians their own children, plus counts", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);
    const guardianCookie = await joinAsGuardianOfChildA(ownerCookie, fixture);

    expect((await record(ownerCookie, fixture, fixture.childA, "yes")).status).toBe(200);
    expect((await record(ownerCookie, fixture, fixture.childB, "maybe")).status).toBe(200);

    const asManager = await read(ownerCookie, fixture);
    expect(asManager.status).toBe(200);
    expect(json(asManager)).toEqual({
      attendance: {
        counts: { yes: 1, no: 0, maybe: 1 },
        entries: [
          { participantId: fixture.childA, displayName: "Casey Kid", status: "yes" },
          { participantId: fixture.childB, displayName: "Robin Kid", status: "maybe" },
        ],
      },
    });

    const asGuardian = await read(guardianCookie, fixture);
    expect(asGuardian.status).toBe(200);
    expect(json(asGuardian)).toEqual({
      attendance: {
        counts: { yes: 1, no: 0, maybe: 1 },
        entries: [{ participantId: fixture.childA, displayName: "Casey Kid", status: "yes" }],
      },
    });

    // Neither projection carries who RECORDED, nor any person id.
    for (const response of [asManager, asGuardian]) {
      const serialized = response.body.toLowerCase();
      for (const forbidden of ["recorded", "person_", "account", "token", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("gives a member who guards nobody the counts and NO entries", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);
    const memberCookie = await joinAsMemberWithoutGuardianEdge(ownerCookie, fixture);

    expect((await record(ownerCookie, fixture, fixture.childA, "yes")).status).toBe(200);
    expect((await record(ownerCookie, fixture, fixture.childB, "maybe")).status).toBe(200);

    // An EMPTY guarded set must filter everything, never degrade to "no
    // filter". Without this reader, a regression that treats "guards nobody"
    // as "unrestricted" would hand every child's name and answer to any team
    // member — and the guardian test above would still pass.
    const asMember = await read(memberCookie, fixture);
    expect(asMember.status).toBe(200);
    expect(json(asMember)).toEqual({
      attendance: { counts: { yes: 1, no: 0, maybe: 1 }, entries: [] },
    });
    const serialized = asMember.body.toLowerCase();
    for (const forbidden of ["casey", "robin", "participant_"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("hides reads from strangers and requires authentication", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);

    expect((await read("", fixture)).status).toBe(401);

    const strangerCookie = await signIn("second-adult");
    const hidden = await read(strangerCookie, fixture);
    expect(hidden.status).toBe(404);
    expect(json(hidden)).toEqual({ error: "team not found" });
  });
});
