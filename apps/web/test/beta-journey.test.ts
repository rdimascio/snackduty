import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
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
