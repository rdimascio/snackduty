import { eq } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import { beforeEach, describe, expect, it } from "vitest";

import type { VerifiedProviderIdentity } from "../app/lib/server/application-contracts";
import {
  authenticationChallenges,
  createAuthentication,
  createAuthenticationSchema,
  verifiedRecipientEmails,
} from "../app/lib/server/authentication";
import {
  accounts,
  createIdentity,
  DEV_ACCOUNT_ID,
  developmentIdentityServices,
  ensureDevelopmentPersona,
  identityServices,
  revokeAllAccountSessions,
} from "../app/lib/server/identity";
import { registerSessionRoutes } from "../app/lib/server/session-routes";

const start = Date.parse("2026-09-14T18:00:00.000Z");

async function fixture() {
  const { db: sql } = await openSqlite(":memory:");
  await new Migrator(sql, [createIdentity, createAuthenticationSchema]).migrate();
  let now = start;
  const services = await identityServices(sql, { mode: "verified", clock: () => now });
  let verified: VerifiedProviderIdentity = {
    issuer: "https://appleid.apple.com",
    subject: "apple-subject-a",
    email: "Coach@Example.COM",
    emailVerified: true,
  };
  let expectedNonce: string | undefined;
  const authentication = createAuthentication({
    ...services,
    clock: () => now,
    secureCookies: true,
    appleVerifier: {
      verify(_token, nonce) {
        expectedNonce = nonce;
        return Promise.resolve(verified);
      },
    },
  });
  return {
    sql,
    services,
    authentication,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    setVerified(next: VerifiedProviderIdentity) {
      verified = next;
    },
    expectedNonce: () => expectedNonce,
  };
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

describe("Apple authentication operations", () => {
  let setup: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    setup = await fixture();
  });

  it("stores only the nonce digest and consumes the challenge exactly once", async () => {
    const challenge = await setup.authentication.challenge();
    const row = await setup.sql
      .prepare("SELECT nonce_hash, status FROM authentication_challenges WHERE id = ?")
      .get([challenge.challengeId]);
    expect(row).toMatchObject({ status: "pending" });
    expect(row).not.toMatchObject({ nonce_hash: challenge.nonce });
    expect((row as { nonce_hash: string }).nonce_hash).toMatch(/^[0-9a-f]{64}$/u);

    const first = await setup.authentication.signIn({
      challengeId: challenge.challengeId,
      identityToken: "provider-token",
      displayName: "Coach Rivera",
      adultConsent: true,
    });
    expect(first?.identity.person.displayName).toBe("Coach Rivera");
    expect(setup.expectedNonce()).toBe((row as { nonce_hash: string }).nonce_hash);
    expect(
      await setup.authentication.signIn({
        challengeId: challenge.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      }),
    ).toBeUndefined();
    expect(
      await setup.sql
        .prepare("SELECT status, consumed_at FROM authentication_challenges WHERE id = ?")
        .get([challenge.challengeId]),
    ).toMatchObject({ status: "consumed", consumed_at: expect.any(String) });
  });

  it("rejects expired challenges and missing explicit adult consent", async () => {
    const expired = await setup.authentication.challenge();
    setup.advance(10 * 60 * 1_000);
    await expect(
      setup.authentication.signIn({
        challengeId: expired.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      }),
    ).resolves.toBeUndefined();

    const fresh = await setup.authentication.challenge();
    await expect(
      setup.authentication.signIn({
        challengeId: fresh.challengeId,
        identityToken: "provider-token",
        adultConsent: false,
      } as never),
    ).rejects.toThrow();
  });

  it("prunes expired Apple challenges while retaining every live challenge", async () => {
    const expiredPending = await setup.authentication.challenge();
    const expiredConsumed = await setup.authentication.challenge();
    const livePending = await setup.authentication.challenge();
    const liveConsumed = await setup.authentication.challenge();
    expect(
      await setup.authentication.signIn({
        challengeId: expiredConsumed.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      }),
    ).toBeDefined();
    expect(
      await setup.authentication.signIn({
        challengeId: liveConsumed.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      }),
    ).toBeDefined();

    await setup.services.db
      .update(authenticationChallenges)
      .set({ expiresAt: new Date(start).toISOString() })
      .where(eq(authenticationChallenges.id, expiredPending.challengeId))
      .run();
    await setup.services.db
      .update(authenticationChallenges)
      .set({ expiresAt: new Date(start).toISOString() })
      .where(eq(authenticationChallenges.id, expiredConsumed.challengeId))
      .run();

    const fresh = await setup.authentication.challenge();
    expect(
      await setup.sql.prepare("SELECT id, status FROM authentication_challenges ORDER BY id").all(),
    ).toEqual(
      [
        { id: livePending.challengeId, status: "pending" },
        { id: liveConsumed.challengeId, status: "consumed" },
        { id: fresh.challengeId, status: "pending" },
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(
      setup.authentication.signIn({
        challengeId: expiredPending.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("links by issuer and subject without changing identity from name or email", async () => {
    const firstChallenge = await setup.authentication.challenge();
    const first = await setup.authentication.signIn({
      challengeId: firstChallenge.challengeId,
      identityToken: "provider-token",
      displayName: "Original Name",
      adultConsent: true,
    });
    const secondChallenge = await setup.authentication.challenge();
    const second = await setup.authentication.signIn({
      challengeId: secondChallenge.challengeId,
      identityToken: "provider-token",
      displayName: "Changed Name",
      adultConsent: true,
    });
    expect(second?.identity).toEqual(first?.identity);
    expect(second?.identity.person.displayName).toBe("Original Name");

    setup.setVerified({
      issuer: "https://appleid.apple.com",
      subject: "different-subject-same-email",
      email: "coach@example.com",
      emailVerified: true,
    });
    const thirdChallenge = await setup.authentication.challenge();
    const third = await setup.authentication.signIn({
      challengeId: thirdChallenge.challengeId,
      identityToken: "provider-token",
      displayName: "Other Adult",
      adultConsent: true,
    });
    expect(third?.identity.account.id).not.toBe(first?.identity.account.id);
    expect(await setup.sql.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({
      count: 2,
    });
  });

  it("serializes concurrent first sign-ins for the same provider subject", async () => {
    const [firstChallenge, secondChallenge] = await Promise.all([
      setup.authentication.challenge(),
      setup.authentication.challenge(),
    ]);

    const [first, second] = await Promise.all([
      setup.authentication.signIn({
        challengeId: firstChallenge.challengeId,
        identityToken: "provider-token-a",
        displayName: "First submitted name",
        adultConsent: true,
      }),
      setup.authentication.signIn({
        challengeId: secondChallenge.challengeId,
        identityToken: "provider-token-b",
        displayName: "Second submitted name",
        adultConsent: true,
      }),
    ]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.identity).toEqual(first?.identity);
    expect(await setup.sql.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({
      count: 1,
    });
    expect(
      await setup.sql.prepare("SELECT COUNT(*) AS count FROM provider_identity_links").get(),
    ).toEqual({ count: 1 });
  });

  it("keeps only current provider-verified email claims active", async () => {
    const firstChallenge = await setup.authentication.challenge();
    const first = await setup.authentication.signIn({
      challengeId: firstChallenge.challengeId,
      identityToken: "provider-token",
      adultConsent: true,
    });
    expect(await verifiedRecipientEmails(setup.services.db, first!.identity.person.id)).toEqual([
      "coach@example.com",
    ]);

    setup.setVerified({
      issuer: "https://appleid.apple.com",
      subject: "apple-subject-a",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
    });
    const nextChallenge = await setup.authentication.challenge();
    await setup.authentication.signIn({
      challengeId: nextChallenge.challengeId,
      identityToken: "provider-token",
      adultConsent: true,
    });
    expect(await verifiedRecipientEmails(setup.services.db, first!.identity.person.id)).toEqual([
      "relay@privaterelay.appleid.com",
    ]);
  });

  it("issues a secure cookie, restores it, revokes it on logout, and clears it", async () => {
    const challenge = await setup.authentication.challenge();
    const signedIn = await setup.authentication.signIn({
      challengeId: challenge.challengeId,
      identityToken: "provider-token",
      adultConsent: true,
    });
    expect(signedIn?.cookie).toContain("__Host-snackday_session=");
    expect(signedIn?.cookie).toContain("; Secure;");
    expect(signedIn?.cookie).toContain("; HttpOnly;");
    const cookie = cookiePair(signedIn!.cookie);
    await expect(setup.authentication.current(cookie)).resolves.toEqual(signedIn?.identity);

    const cleared = await setup.authentication.logout(cookie);
    expect(cleared).toContain("__Host-snackday_session=;");
    expect(cleared).toContain("Max-Age=0");
    await expect(setup.authentication.current(cookie)).resolves.toBeUndefined();
  });

  it("expires durable sessions against the injected clock", async () => {
    const challenge = await setup.authentication.challenge();
    const signedIn = await setup.authentication.signIn({
      challengeId: challenge.challengeId,
      identityToken: "provider-token",
      adultConsent: true,
    });
    const cookie = cookiePair(signedIn!.cookie);
    setup.advance(30 * 24 * 60 * 60 * 1_000);
    await expect(setup.authentication.current(cookie)).resolves.toBeUndefined();
    expect(await setup.sql.prepare("SELECT COUNT(*) AS count FROM lesto_sessions").get()).toEqual({
      count: 0,
    });
  });

  it("serves the frozen challenge, sign-in, current-session and logout routes", async () => {
    const app = await createApp({
      db: setup.sql,
      app: registerSessionRoutes(lesto(), setup.authentication),
      migrations: [],
    });
    const challengeResponse = await app.handle("POST", "/api/auth/apple/challenge");
    expect(challengeResponse.status).toBe(200);
    const challenge = JSON.parse(challengeResponse.body) as { challengeId: string; nonce: string };
    const signIn = await app.handle("POST", "/api/auth/apple/sign-in", {
      body: {
        challengeId: challenge.challengeId,
        identityToken: "provider-token",
        adultConsent: true,
      },
    });
    expect(signIn.status).toBe(200);
    const setCookie = Object.entries(signIn.headers).find(
      ([name]) => name.toLowerCase() === "set-cookie",
    )?.[1];
    const cookie = cookiePair(Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? ""));
    expect((await app.handle("GET", "/api/session", { headers: { cookie } })).status).toBe(200);
    const logout = await app.handle("POST", "/api/session/logout", { headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(JSON.parse(logout.body)).toEqual({ signedOut: true });
    expect((await app.handle("GET", "/api/session", { headers: { cookie } })).status).toBe(401);
  });

  it("rejects inactive accounts and revokes all sessions for an account", async () => {
    const challenge = await setup.authentication.challenge();
    const signedIn = await setup.authentication.signIn({
      challengeId: challenge.challengeId,
      identityToken: "provider-token",
      adultConsent: true,
    });
    const cookie = cookiePair(signedIn!.cookie);
    await setup.services.db
      .update(accounts)
      .set({ status: "revoked" })
      .where(eq(accounts.id, signedIn!.identity.account.id))
      .run();
    await expect(setup.authentication.current(cookie)).resolves.toBeUndefined();
    expect(await revokeAllAccountSessions(setup.sql, signedIn!.identity.account.id)).toBe(1);
    expect(await setup.sql.prepare("SELECT COUNT(*) AS count FROM lesto_sessions").get()).toEqual({
      count: 0,
    });
  });
});

describe("session environment isolation", () => {
  it("does not accept development sessions through verified services on the same database", async () => {
    const { db: sql } = await openSqlite(":memory:");
    const development = await developmentIdentityServices(sql);
    const verified = await identityServices(sql, { mode: "verified" });
    await new Migrator(sql, [createIdentity]).migrate();
    await ensureDevelopmentPersona(development.db, "default");
    const session = await development.sessions.create(DEV_ACCOUNT_ID, 60_000);
    await expect(development.sessions.verify(session.token)).resolves.toBeDefined();
    await expect(verified.sessions.verify(session.token)).resolves.toBeUndefined();

    const releaseAuthentication = createAuthentication({
      ...verified,
      clock: Date.now,
      secureCookies: true,
    });
    await expect(
      releaseAuthentication.current(`__Host-snackday_session=${session.token}`),
    ).resolves.toBeUndefined();
  });
});
