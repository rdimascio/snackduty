import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  attendanceReadResponseSchema,
  attendanceResponseSchema,
  createEventResponseSchema,
  dutySlotResponseSchema,
  dutySlotsResponseSchema,
  seasonEventsResponseSchema,
} from "@snackday/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAppleIdentityVerifier } from "../app/lib/server/apple-identity";
import { DEV_SESSION_COOKIE, VERIFIED_SESSION_TTL_MS } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { INVITATION_TTL_MS } from "../app/lib/server/invitations";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication, RuntimeConfiguration } from "../runtime";

const issuer = "https://appleid.apple.com";
const audience = "com.snackday.beta.acceptance";
const sameOrigin = { "sec-fetch-site": "same-origin" } as const;
const scratchDirectories: string[] = [];
const openRuntimes: RuntimeApplication[] = [];

let privateKey: CryptoKey;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  keyResolver = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "beta-key", alg: "RS256" }] });
});

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

interface MutableClock {
  now: number;
}

interface Adult {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
}

interface AdultSession {
  readonly cookie: string;
  readonly identity: {
    readonly account: { readonly id: string };
    readonly person: { readonly id: string; readonly displayName: string };
  };
}

interface TeamFixture {
  readonly teamId: string;
  readonly seasonId: string;
}

type RuntimeApp = RuntimeApplication["app"];
type Response = Awaited<ReturnType<RuntimeApp["handle"]>>;

function json(response: Response): unknown {
  return JSON.parse(response.body);
}

function header(response: Response, name: string): string {
  const value = Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function cookieOf(response: Response): string {
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

function sessionToken(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

async function nonceDigest(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Buffer.from(digest).toString("hex");
}

function runtimeConfiguration(databasePath: string): RuntimeConfiguration {
  return {
    mode: "staging",
    databasePath,
    host: "127.0.0.1",
    port: 1,
    publicBaseUrl: new URL("https://staging.snackduty.test"),
    appleClientId: audience,
    upstreamCredentialPathLoggingSafe: false,
  };
}

async function runtimeFixture(clock: MutableClock) {
  const directory = await mkdtemp(join(tmpdir(), "snackduty-beta-journey-"));
  scratchDirectories.push(directory);
  const inviteDelivery = devInviteDeliverer();
  const runtime = await openRuntimeApplication(
    runtimeConfiguration(join(directory, "snackduty.db")),
    {
      clock: () => clock.now,
      inviteDelivery,
      invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
      appleVerifier: createAppleIdentityVerifier({
        audience,
        issuer,
        keyResolver,
        clock: () => clock.now,
      }),
    },
  );
  openRuntimes.push(runtime);
  return { runtime, inviteDelivery };
}

async function appleToken(adult: Adult, nonce: string, now: number): Promise<string> {
  return new SignJWT({ nonce: await nonceDigest(nonce), email: adult.email, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "beta-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(adult.subject)
    .setIssuedAt(Math.floor(now / 1_000))
    .setExpirationTime(Math.floor(now / 1_000) + 300)
    .sign(privateKey);
}

async function signIn(
  app: RuntimeApp,
  adult: Adult,
  clock: MutableClock,
): Promise<AdultSession & { readonly request: object }> {
  const challenge = await app.handle("POST", "/api/auth/apple/challenge", {
    headers: sameOrigin,
  });
  expect(challenge.status).toBe(200);
  const challengeBody = json(challenge) as { challengeId: string; nonce: string };
  const request = {
    challengeId: challengeBody.challengeId,
    identityToken: await appleToken(adult, challengeBody.nonce, clock.now),
    displayName: adult.displayName,
    adultConsent: true as const,
  };
  const response = await app.handle("POST", "/api/auth/apple/sign-in", {
    headers: sameOrigin,
    body: request,
  });
  expect(response.status).toBe(200);
  const cookie = cookieOf(response);
  expect(cookie).toStartWith("__Host-snackday_session=");
  return {
    cookie,
    identity: json(response) as AdultSession["identity"],
    request,
  };
}

function post(app: RuntimeApp, path: string, cookie: string, body: unknown): Promise<Response> {
  return app.handle("POST", path, { headers: { ...sameOrigin, cookie }, body });
}

async function createTeamFixture(
  app: RuntimeApp,
  cookie: string,
  name: string,
): Promise<TeamFixture> {
  const teamResponse = await post(app, "/api/teams", cookie, { name });
  expect(teamResponse.status).toBe(201);
  const teamId = (json(teamResponse) as { team: { id: string } }).team.id;
  const seasonResponse = await post(app, `/api/teams/${teamId}/seasons`, cookie, {
    label: "Fall 2026",
    startDate: "2026-09-01",
    endDate: "2026-11-15",
    timeZone: "America/Los_Angeles",
  });
  expect(seasonResponse.status).toBe(201);
  const seasonId = (json(seasonResponse) as { season: { id: string } }).season.id;
  return { teamId, seasonId };
}

async function addChild(
  app: RuntimeApp,
  cookie: string,
  fixture: TeamFixture,
  displayName: string,
): Promise<string> {
  const response = await post(
    app,
    `/api/teams/${fixture.teamId}/seasons/${fixture.seasonId}/participants`,
    cookie,
    { displayName, birthDate: "2018-04-09" },
  );
  expect(response.status).toBe(201);
  return (json(response) as { participant: { participantId: string } }).participant.participantId;
}

function deliveredToken(delivery: { readonly inviteUrl: string }): string {
  expect(delivery.inviteUrl).toStartWith("/invite#");
  return delivery.inviteUrl.slice("/invite#".length);
}

async function expectPersistedDeliveries(
  runtime: RuntimeApplication,
  invitationId: string,
  count: number,
): Promise<void> {
  const rows = await runtime.sql
    .prepare("SELECT status, delivered_at FROM invitation_delivery_outbox WHERE invitation_id = ?")
    .all([invitationId]);
  expect(rows).toHaveLength(count);
  expect(rows).toEqual(
    expect.arrayContaining(
      Array.from({ length: count }, () =>
        expect.objectContaining({ status: "delivered", delivered_at: expect.any(String) }),
      ),
    ),
  );
}

const ownerCoach: Adult = {
  subject: "apple-owner-coach",
  email: "owner.coach@example.com",
  displayName: "Morgan Coach",
};
const ownerFamily: Adult = {
  subject: "apple-owner-family",
  email: "owner.family@example.com",
  displayName: "Robin Manager",
};
const dualRoleAdult: Adult = {
  subject: "apple-dual-role",
  email: "alex@example.com",
  displayName: "Alex Coach Parent",
};
const unrelatedAdult: Adult = {
  subject: "apple-unrelated",
  email: "forwarder@example.com",
  displayName: "Taylor Forwarder",
};

describe("coach-parent beta composed runtime", () => {
  it("keeps coaching, parenting, delegation, recipient binding, and child privacy scoped", async () => {
    const clock = { now: Date.parse("2026-09-14T18:00:00.000Z") };
    const { runtime, inviteDelivery } = await runtimeFixture(clock);
    const { app } = runtime;

    expect((await app.handle("POST", "/api/dev/sign-in", { headers: sameOrigin })).status).toBe(
      404,
    );

    const coachOwner = await signIn(app, ownerCoach, clock);
    const familyOwner = await signIn(app, ownerFamily, clock);
    const alex = await signIn(app, dualRoleAdult, clock);
    const forwarded = await signIn(app, unrelatedAdult, clock);
    const repeatedAlex = await signIn(app, dualRoleAdult, clock);
    expect(repeatedAlex.identity).toEqual(alex.identity);

    const coached = await createTeamFixture(app, coachOwner.cookie, "Coached Falcons");
    const family = await createTeamFixture(app, familyOwner.cookie, "Family Comets");
    const coachedChildId = await addChild(app, coachOwner.cookie, coached, "Coached Player");
    const ownChildId = await addChild(app, familyOwner.cookie, family, "Alex's Player");
    const peerChildId = await addChild(app, familyOwner.cookie, family, "Peer Player");

    const coachInvite = await post(
      app,
      `/api/teams/${coached.teamId}/invitations`,
      coachOwner.cookie,
      {
        invitedRole: "adult",
        inviteeLabel: "Alex as team adult",
        recipientBinding: { kind: "confirmed_person", personId: alex.identity.person.id },
      },
    );
    expect(coachInvite.status).toBe(201);
    const coachInvitationId = (json(coachInvite) as { invitation: { id: string } }).invitation.id;
    await expectPersistedDeliveries(runtime, coachInvitationId, 1);
    const originalCoachToken = deliveredToken(inviteDelivery.deliveries.at(-1)!);
    const rotated = await post(
      app,
      `/api/teams/${coached.teamId}/invitations/${coachInvitationId}/resend`,
      coachOwner.cookie,
      {},
    );
    expect(rotated.status).toBe(200);
    await expectPersistedDeliveries(runtime, coachInvitationId, 2);
    const rotatedCoachToken = deliveredToken(inviteDelivery.deliveries.at(-1)!);
    expect(rotatedCoachToken).not.toBe(originalCoachToken);
    expect(
      (await post(app, "/api/invitations/accept", alex.cookie, { token: originalCoachToken }))
        .status,
    ).toBe(404);
    expect(
      (await post(app, "/api/invitations/accept", alex.cookie, { token: rotatedCoachToken }))
        .status,
    ).toBe(200);

    // Team membership alone exposes only the public player projection. The
    // later owner grant changes team operations; it does not manufacture a
    // guardian edge.
    const adultRoster = await app.handle(
      "GET",
      `/api/teams/${coached.teamId}/seasons/${coached.seasonId}/roster`,
      { headers: { cookie: alex.cookie } },
    );
    expect(adultRoster.status).toBe(200);
    expect(
      (json(adultRoster) as { roster: Array<Record<string, unknown>> }).roster[0],
    ).not.toHaveProperty("birthDate");
    expect(
      (await app.handle("GET", `/api/teams/${family.teamId}`, { headers: { cookie: alex.cookie } }))
        .status,
    ).toBe(404);

    const granted = await post(
      app,
      `/api/teams/${coached.teamId}/adult-members/${alex.identity.person.id}/co-coach/grant`,
      coachOwner.cookie,
      {},
    );
    expect(granted.status).toBe(200);

    const familyInvite = await post(
      app,
      `/api/teams/${family.teamId}/invitations`,
      familyOwner.cookie,
      {
        invitedRole: "adult",
        inviteeLabel: "Alex's parent access",
        participantId: ownChildId,
        relationship: "parent",
        recipientBinding: { kind: "verified_email", email: "ALEX@example.com" },
      },
    );
    expect(familyInvite.status).toBe(201);
    const familyInvitationId = (json(familyInvite) as { invitation: { id: string } }).invitation.id;
    await expectPersistedDeliveries(runtime, familyInvitationId, 1);
    const familyToken = deliveredToken(inviteDelivery.deliveries.at(-1)!);
    expect(
      (await post(app, "/api/invitations/accept", forwarded.cookie, { token: familyToken })).status,
    ).toBe(404);
    const accepted = await post(app, "/api/invitations/accept", alex.cookie, {
      token: familyToken,
    });
    expect(accepted.status).toBe(200);
    expect(json(accepted)).toMatchObject({ membership: { role: "adult" } });
    expect(
      (await post(app, "/api/invitations/accept", alex.cookie, { token: familyToken })).status,
    ).toBe(200);

    const directoryResponse = await app.handle("GET", "/api/teams", {
      headers: { cookie: alex.cookie },
    });
    expect(directoryResponse.status).toBe(200);
    const directory = (
      json(directoryResponse) as {
        teams: Array<{
          team: { id: string };
          access: string;
          capabilities: { read: boolean; manage: boolean; delegate: boolean };
        }>;
      }
    ).teams;
    expect(
      directory
        .map(({ team, access, capabilities }) => ({
          teamId: team.id,
          access,
          capabilities,
        }))
        .toSorted((left, right) => left.teamId.localeCompare(right.teamId)),
    ).toEqual(
      [
        {
          teamId: coached.teamId,
          access: "manage",
          capabilities: { read: true, manage: true, delegate: false },
        },
        {
          teamId: family.teamId,
          access: "read",
          capabilities: { read: true, manage: false, delegate: false },
        },
      ].toSorted((left, right) => left.teamId.localeCompare(right.teamId)),
    );

    expect(
      (
        await post(app, `/api/teams/${coached.teamId}/seasons`, alex.cookie, {
          label: "Coach-created season",
          startDate: "2027-01-01",
          endDate: "2027-04-01",
          timeZone: "America/Los_Angeles",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(app, `/api/teams/${family.teamId}/seasons`, alex.cookie, {
          label: "Forged family management",
          startDate: "2027-01-01",
          endDate: "2027-04-01",
          timeZone: "America/Los_Angeles",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(app, `/api/teams/${coached.teamId}/invitations`, alex.cookie, {
          invitedRole: "adult",
          inviteeLabel: "Coach cannot delegate",
          recipientBinding: {
            kind: "confirmed_person",
            personId: forwarded.identity.person.id,
          },
        })
      ).status,
    ).toBe(404);

    const familyRosterResponse = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/seasons/${family.seasonId}/roster`,
      { headers: { cookie: alex.cookie } },
    );
    expect(familyRosterResponse.status).toBe(200);
    const familyRoster = (json(familyRosterResponse) as { roster: Array<Record<string, unknown>> })
      .roster;
    expect(familyRoster.find((entry) => entry["participantId"] === ownChildId)).toMatchObject({
      participantId: ownChildId,
      birthDate: "2018-04-09",
      guardians: [
        { displayName: dualRoleAdult.displayName, relationship: "parent", status: "active" },
      ],
    });
    const peerEntry = familyRoster.find((entry) => entry["participantId"] === peerChildId);
    expect(peerEntry).not.toHaveProperty("birthDate");
    expect(peerEntry).toMatchObject({
      guardians: [],
    });

    const coachedRoster = await app.handle(
      "GET",
      `/api/teams/${coached.teamId}/seasons/${coached.seasonId}/roster`,
      { headers: { cookie: alex.cookie } },
    );
    expect(coachedRoster.status).toBe(200);
    expect(json(coachedRoster)).toMatchObject({
      roster: [{ participantId: coachedChildId, birthDate: "2018-04-09" }],
    });
    expect(
      (
        await app.handle("GET", `/api/teams/${family.teamId}/seasons/${coached.seasonId}/roster`, {
          headers: { cookie: alex.cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.handle("GET", `/api/teams/${family.teamId}`, {
          headers: { cookie: forwarded.cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(app, `/api/participants/${peerChildId}/guardians`, alex.cookie, {
          displayName: "Forged guardian",
          relationship: "parent",
        })
      ).status,
    ).toBe(404);

    // The first coordination journey stays on the selected family season:
    // its owner creates once, then the parent responds only for their own
    // child and claims the snack slot as themselves.
    const eventRequestId = "f15f9510-7369-4d5f-a33e-68b6d59eb768";
    const eventInput = {
      title: "Saturday practice",
      kind: "practice",
      location: "Community field",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "10:00",
        durationMinutes: 60,
        frequency: "once",
        startDate: "2026-10-03",
      },
      requestId: eventRequestId,
      snackDuty: {
        label: "Snacks",
        instructions: "Bring individually wrapped snacks.",
      },
    };
    const createdEvent = await post(
      app,
      `/api/teams/${family.teamId}/seasons/${family.seasonId}/events`,
      familyOwner.cookie,
      eventInput,
    );
    expect(createdEvent.status).toBe(201);
    const createdCoordination = createEventResponseSchema.parse(json(createdEvent));
    expect(createdCoordination.series).toMatchObject({
      teamId: family.teamId,
      seasonId: family.seasonId,
    });
    expect(createdCoordination.occurrences).toHaveLength(1);
    expect(createdCoordination.dutySlots).toHaveLength(1);
    const occurrenceId = createdCoordination.occurrences[0]!.id;
    const dutySlotId = createdCoordination.dutySlots[0]!.id;
    expect(createdCoordination.occurrences[0]!.seriesId).toBe(createdCoordination.series.id);
    expect(createdCoordination.dutySlots[0]!.occurrenceId).toBe(occurrenceId);
    expect(createdCoordination.dutySlots[0]!.assignee).toBeUndefined();

    const replayedEvent = await post(
      app,
      `/api/teams/${family.teamId}/seasons/${family.seasonId}/events`,
      familyOwner.cookie,
      eventInput,
    );
    expect(replayedEvent.status).toBe(201);
    expect(json(replayedEvent)).toEqual(json(createdEvent));
    const conflictingReplay = await post(
      app,
      `/api/teams/${family.teamId}/seasons/${family.seasonId}/events`,
      familyOwner.cookie,
      { ...eventInput, title: "Conflicting retry" },
    );
    expect(conflictingReplay.status).toBe(409);
    expect(json(conflictingReplay)).toMatchObject({ code: "request_id_conflict" });

    const schedule = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/seasons/${family.seasonId}/events`,
      { headers: { cookie: alex.cookie } },
    );
    expect(schedule.status).toBe(200);
    const scheduleBody = seasonEventsResponseSchema.parse(json(schedule));
    expect(scheduleBody.events).toHaveLength(1);
    expect(scheduleBody).toMatchObject({
      events: [
        {
          series: { id: createdCoordination.series.id },
          occurrences: [{ id: occurrenceId, attendance: { yes: 0, no: 0, maybe: 0 } }],
        },
      ],
    });

    const firstAttendance = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/attendance`,
      { headers: { cookie: alex.cookie } },
    );
    expect(firstAttendance.status).toBe(200);
    const firstAttendanceBody = attendanceReadResponseSchema.parse(json(firstAttendance));
    expect(firstAttendanceBody.attendance.counts).toEqual({ yes: 0, no: 0, maybe: 0 });
    expect(firstAttendanceBody.attendance.entries).toEqual([]);
    expect(firstAttendanceBody.attendance.responseOptions).toEqual([
      { participantId: ownChildId, displayName: "Alex's Player" },
    ]);
    expect(firstAttendanceBody.attendance.responseOptions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ participantId: peerChildId })]),
    );

    const recordedAttendance = await post(
      app,
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/attendance`,
      alex.cookie,
      { participantId: ownChildId, status: "yes" },
    );
    expect(recordedAttendance.status).toBe(200);
    expect(attendanceResponseSchema.parse(json(recordedAttendance))).toEqual({
      attendance: { participantId: ownChildId, status: "yes" },
    });
    expect(
      (
        await post(
          app,
          `/api/teams/${family.teamId}/occurrences/${occurrenceId}/attendance`,
          alex.cookie,
          { participantId: peerChildId, status: "yes" },
        )
      ).status,
    ).toBe(404);

    const persistedAttendance = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/attendance`,
      { headers: { cookie: alex.cookie } },
    );
    expect(persistedAttendance.status).toBe(200);
    expect(attendanceReadResponseSchema.parse(json(persistedAttendance))).toEqual({
      attendance: {
        counts: { yes: 1, no: 0, maybe: 0 },
        entries: [
          {
            participantId: ownChildId,
            displayName: "Alex's Player",
            status: "yes",
          },
        ],
        responseOptions: [
          {
            participantId: ownChildId,
            displayName: "Alex's Player",
            status: "yes",
          },
        ],
      },
    });

    const unclaimedSlots = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/duty-slots`,
      { headers: { cookie: alex.cookie } },
    );
    expect(unclaimedSlots.status).toBe(200);
    expect(dutySlotsResponseSchema.parse(json(unclaimedSlots))).toMatchObject({
      dutySlots: [{ id: dutySlotId, occurrenceId }],
    });

    const claimedDuty = await post(
      app,
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/duty-slots/${dutySlotId}/claim`,
      alex.cookie,
      {},
    );
    expect(claimedDuty.status).toBe(200);
    expect(dutySlotResponseSchema.parse(json(claimedDuty))).toMatchObject({
      dutySlot: {
        id: dutySlotId,
        occurrenceId,
        assignee: {
          personId: alex.identity.person.id,
          displayName: dualRoleAdult.displayName,
        },
      },
    });
    const persistedSlots = await app.handle(
      "GET",
      `/api/teams/${family.teamId}/occurrences/${occurrenceId}/duty-slots`,
      { headers: { cookie: alex.cookie } },
    );
    expect(persistedSlots.status).toBe(200);
    expect(dutySlotsResponseSchema.parse(json(persistedSlots))).toMatchObject({
      dutySlots: [
        {
          id: dutySlotId,
          assignee: {
            personId: alex.identity.person.id,
            displayName: dualRoleAdult.displayName,
          },
        },
      ],
    });

    expect(
      (
        await app.handle("GET", `/api/teams/${family.teamId}/seasons/${coached.seasonId}/events`, {
          headers: { cookie: alex.cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          app,
          `/api/teams/${coached.teamId}/occurrences/${occurrenceId}/attendance`,
          alex.cookie,
          { participantId: ownChildId, status: "maybe" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          app,
          `/api/teams/${family.teamId}/occurrences/${occurrenceId}/duty-slots/${dutySlotId}/claim`,
          forwarded.cookie,
          {},
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await post(
          app,
          `/api/teams/${coached.teamId}/adult-members/${alex.identity.person.id}/co-coach/revoke`,
          coachOwner.cookie,
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(app, `/api/teams/${coached.teamId}/seasons`, alex.cookie, {
          label: "After coaching revoked",
          startDate: "2027-05-01",
          endDate: "2027-08-01",
          timeZone: "America/Los_Angeles",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          app,
          `/api/teams/${coached.teamId}/seasons/${coached.seasonId}/events`,
          alex.cookie,
          {
            ...eventInput,
            requestId: "8b363a3d-a183-4c8e-8ab1-e55eef95c132",
            title: "Revoked coach cannot create",
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.handle("GET", `/api/teams/${family.teamId}/seasons/${family.seasonId}/roster`, {
          headers: { cookie: alex.cookie },
        })
      ).status,
    ).toBe(200);

    const expiringInvite = await post(
      app,
      `/api/teams/${family.teamId}/invitations`,
      familyOwner.cookie,
      {
        invitedRole: "adult",
        inviteeLabel: "Expiring recipient",
        recipientBinding: {
          kind: "confirmed_person",
          personId: forwarded.identity.person.id,
        },
      },
    );
    expect(expiringInvite.status).toBe(201);
    const expiringInvitationId = (json(expiringInvite) as { invitation: { id: string } }).invitation
      .id;
    await expectPersistedDeliveries(runtime, expiringInvitationId, 1);
    const expiringToken = deliveredToken(inviteDelivery.deliveries.at(-1)!);
    clock.now += INVITATION_TTL_MS;
    expect(
      (await post(app, "/api/invitations/accept", forwarded.cookie, { token: expiringToken }))
        .status,
    ).toBe(404);
  });

  it("restores a verified session and rejects replay, revocation, logout, and expiry", async () => {
    const clock = { now: Date.parse("2026-09-14T18:00:00.000Z") };
    const { runtime } = await runtimeFixture(clock);
    const { app } = runtime;
    const first = await signIn(app, dualRoleAdult, clock);

    const sessionTeam = await createTeamFixture(app, first.cookie, "Session Revocation Team");

    expect(
      (await app.handle("GET", "/api/session", { headers: { cookie: first.cookie } })).status,
    ).toBe(200);
    const developmentCookie = `${DEV_SESSION_COOKIE}=${sessionToken(first.cookie)}`;
    expect(
      (await app.handle("GET", "/api/session", { headers: { cookie: developmentCookie } })).status,
    ).toBe(401);
    expect(
      (await app.handle("GET", "/api/teams", { headers: { cookie: developmentCookie } })).status,
    ).toBe(401);
    expect(
      (
        await post(app, "/api/teams", developmentCookie, {
          name: "Development cookie must not authorize",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.handle("POST", "/api/auth/apple/sign-in", {
          headers: sameOrigin,
          body: first.request,
        })
      ).status,
    ).toBe(401);

    await runtime.sessions.revoke(sessionToken(first.cookie));
    expect(
      (await app.handle("GET", "/api/session", { headers: { cookie: first.cookie } })).status,
    ).toBe(401);
    expect(
      (
        await app.handle(
          "GET",
          `/api/teams/${sessionTeam.teamId}/seasons/${sessionTeam.seasonId}/events`,
          { headers: { cookie: first.cookie } },
        )
      ).status,
    ).toBe(401);

    const second = await signIn(app, dualRoleAdult, clock);
    expect(second.identity).toEqual(first.identity);
    const logout = await app.handle("POST", "/api/session/logout", {
      headers: { ...sameOrigin, cookie: second.cookie },
    });
    expect(logout.status).toBe(200);
    expect(json(logout)).toEqual({ signedOut: true });
    expect(header(logout, "set-cookie")).toContain("Max-Age=0");
    expect(
      (await app.handle("GET", "/api/session", { headers: { cookie: second.cookie } })).status,
    ).toBe(401);
    expect(
      (await post(app, "/api/teams", second.cookie, { name: "Logged-out replay" })).status,
    ).toBe(401);

    const third = await signIn(app, dualRoleAdult, clock);
    clock.now += VERIFIED_SESSION_TTL_MS;
    expect(
      (await app.handle("GET", "/api/session", { headers: { cookie: third.cookie } })).status,
    ).toBe(401);
  });
});
