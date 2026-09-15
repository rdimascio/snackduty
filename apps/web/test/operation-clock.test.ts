import { createApp } from "@lesto/kernel";
import { lesto } from "@lesto/web";
import { afterAll, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const clock = { now: Date.parse("2040-04-02T15:00:00.000Z") };
const { default: config, services } = await import("./support/application").then((module) =>
  module.testApplication(() => clock.now),
);
const [{ registerRosterRoutes }, { registerRosterImportRoutes }, { registerTeamReadRoutes }] =
  await Promise.all([
    import("../app/lib/server/roster"),
    import("../app/lib/server/roster-import"),
    import("../app/lib/server/team-reads"),
  ]);

const application = await createApp(config);
const roster = registerRosterRoutes(lesto(), services.db, services.sessions, () => clock.now);
const rosterImport = registerRosterImportRoutes(
  lesto(),
  services.db,
  services.sessions,
  () => clock.now,
);
const teamReads = registerTeamReadRoutes(lesto(), services.db, services.sessions, () => clock.now);

afterAll(async () => {
  await config.db.exec(
    "DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
});

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const sameOrigin = { "sec-fetch-site": "same-origin" };

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await application.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function createTeamAndSeason(cookie: string) {
  const teamResponse = await application.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Clockwork Falcons" },
  });
  expect(teamResponse.status).toBe(201);
  const teamId = (json(teamResponse) as { team: { id: string } }).team.id;

  const seasonResponse = await application.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2040",
      startDate: "2040-03-01",
      endDate: "2040-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(seasonResponse.status).toBe(201);
  const seasonId = (json(seasonResponse) as { season: { id: string } }).season.id;
  return { teamId, seasonId };
}

it("uses one injected clock for roster writes, imports, and invitation expiry", async () => {
  const initialOwnerCookie = await signIn();
  await signIn("second-adult");
  const { teamId, seasonId } = await createTeamAndSeason(initialOwnerCookie);

  const participantTime = new Date(clock.now).toISOString();
  const added = await roster.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    {
      headers: { cookie: initialOwnerCookie },
      body: { displayName: "Clock Child", birthDate: "2032-04-09" },
    },
  );
  expect(added.status).toBe(201);
  const participantId = (json(added) as { participant: { participantId: string } }).participant
    .participantId;
  expect(
    await config.db
      .prepare(
        "SELECT p.created_at AS person_created_at, p.updated_at AS person_updated_at, participant.created_at AS participant_created_at, participant.updated_at AS participant_updated_at, membership.created_at AS membership_created_at, membership.updated_at AS membership_updated_at FROM participants participant JOIN people p ON p.id = participant.person_id JOIN memberships membership ON membership.member_participant_id = participant.id WHERE participant.id = ?",
      )
      .get([participantId]),
  ).toEqual({
    person_created_at: participantTime,
    person_updated_at: participantTime,
    participant_created_at: participantTime,
    participant_updated_at: participantTime,
    membership_created_at: participantTime,
    membership_updated_at: participantTime,
  });

  clock.now += 60_000;
  const guardianTime = new Date(clock.now).toISOString();
  const attached = await roster.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { cookie: initialOwnerCookie },
    body: { displayName: "Clock Guardian", relationship: "parent" },
  });
  expect(attached.status).toBe(201);
  const guardianId = (json(attached) as { guardian: { guardianId: string } }).guardian.guardianId;
  expect(
    await config.db
      .prepare(
        "SELECT p.created_at AS person_created_at, p.updated_at AS person_updated_at, edge.created_at AS edge_created_at, edge.updated_at AS edge_updated_at FROM guardian_relationships edge JOIN people p ON p.id = edge.guardian_person_id WHERE edge.id = ?",
      )
      .get([guardianId]),
  ).toEqual({
    person_created_at: guardianTime,
    person_updated_at: guardianTime,
    edge_created_at: guardianTime,
    edge_updated_at: guardianTime,
  });

  clock.now += 60_000;
  const importTime = new Date(clock.now).toISOString();
  const committed = await rosterImport.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/roster/import`,
    {
      headers: { cookie: initialOwnerCookie },
      body: {
        rows: [
          {
            displayName: "Imported Child",
            birthDate: "2033-05-10",
            guardians: [{ displayName: "Imported Guardian", relationship: "caregiver" }],
          },
        ],
      },
    },
  );
  expect(committed.status).toBe(201);
  expect(
    await config.db
      .prepare(
        "SELECT created_at, updated_at FROM people WHERE display_name IN ('Imported Child', 'Imported Guardian') ORDER BY display_name",
      )
      .all(),
  ).toEqual([
    { created_at: importTime, updated_at: importTime },
    { created_at: importTime, updated_at: importTime },
  ]);
  expect(
    await config.db
      .prepare(
        "SELECT participant.created_at AS participant_created_at, participant.updated_at AS participant_updated_at, membership.created_at AS membership_created_at, membership.updated_at AS membership_updated_at, edge.created_at AS edge_created_at, edge.updated_at AS edge_updated_at FROM participants participant JOIN memberships membership ON membership.member_participant_id = participant.id JOIN guardian_relationships edge ON edge.participant_id = participant.id JOIN people p ON p.id = participant.person_id WHERE p.display_name = 'Imported Child'",
      )
      .get(),
  ).toEqual({
    participant_created_at: importTime,
    participant_updated_at: importTime,
    membership_created_at: importTime,
    membership_updated_at: importTime,
    edge_created_at: importTime,
    edge_updated_at: importTime,
  });

  const invited = await application.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: initialOwnerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "Clock Child's parent",
      participantId,
      relationship: "parent",
      recipientBinding: { kind: "confirmed_person", personId: "person_dev_second_adult" },
    },
  });
  expect(invited.status).toBe(201);
  const expiresAt = (json(invited) as { invitation: { expiresAt: string } }).invitation.expiresAt;

  clock.now = Date.parse(expiresAt);
  const currentOwnerCookie = await signIn();
  const rosterResponse = await teamReads.handle(
    "GET",
    `/api/teams/${teamId}/seasons/${seasonId}/roster`,
    { headers: { cookie: currentOwnerCookie } },
  );
  expect(rosterResponse.status).toBe(200);
  const entries = (
    json(rosterResponse) as {
      roster: { participantId: string; guardianInvitations?: Record<string, number> }[];
    }
  ).roster;
  expect(
    entries.find((entry) => entry.participantId === participantId)?.guardianInvitations,
  ).toEqual({ pending: 0, expired: 1, accepted: 0 });
});
