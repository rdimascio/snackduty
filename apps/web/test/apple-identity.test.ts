import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createAppleIdentityVerifier } from "../app/lib/server/apple-identity";

const now = Date.parse("2026-09-14T18:00:00.000Z");
const issuer = "https://appleid.apple.com";
const audience = "com.snackday.beta";
let privateKey: CryptoKey;
let verifier: ReturnType<typeof createAppleIdentityVerifier>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  verifier = createAppleIdentityVerifier({
    audience,
    issuer,
    clock: () => now,
    keyResolver: createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }),
  });
});

function token(
  overrides: Partial<{
    issuer: string;
    audience: string;
    subject: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    email: string;
    emailVerified: boolean | string;
  }> = {},
) {
  return new SignJWT({
    nonce: overrides.nonce ?? "expected-nonce-digest",
    email: overrides.email ?? "Coach@Example.COM",
    email_verified: overrides.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? "apple-subject-123")
    .setIssuedAt(overrides.issuedAt ?? Math.floor(now / 1_000))
    .setExpirationTime(overrides.expiresAt ?? Math.floor(now / 1_000) + 300)
    .sign(privateKey);
}

describe("Apple identity-token verification", () => {
  it("cryptographically verifies issuer, audience, time, nonce and stable subject", async () => {
    await expect(verifier.verify(await token(), "expected-nonce-digest")).resolves.toEqual({
      issuer,
      subject: "apple-subject-123",
      email: "coach@example.com",
      emailVerified: true,
    });
  });

  it.each([
    [{ issuer: "https://attacker.example" }, "expected-nonce-digest"],
    [{ audience: "com.other.app" }, "expected-nonce-digest"],
    [{ issuedAt: Math.floor(now / 1_000) - 601 }, "expected-nonce-digest"],
    [{ issuedAt: Math.floor(now / 1_000) + 1 }, "expected-nonce-digest"],
    [{ expiresAt: Math.floor(now / 1_000) - 1 }, "expected-nonce-digest"],
    [{ nonce: "other-digest" }, "expected-nonce-digest"],
  ] as const)("rejects invalid fixed claims %#", async (overrides, nonce) => {
    await expect(verifier.verify(await token(overrides), nonce)).resolves.toBeUndefined();
  });

  it("rejects a token signed by an untrusted key", async () => {
    const attacker = await generateKeyPair("RS256");
    const forged = await new SignJWT({ nonce: "expected-nonce-digest" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("apple-subject-123")
      .setExpirationTime(Math.floor(now / 1_000) + 300)
      .sign(attacker.privateKey);
    await expect(verifier.verify(forged, "expected-nonce-digest")).resolves.toBeUndefined();
  });

  it("does not expose an email claim Apple did not verify", async () => {
    await expect(
      verifier.verify(await token({ emailVerified: false }), "expected-nonce-digest"),
    ).resolves.toEqual({ issuer, subject: "apple-subject-123", emailVerified: false });
  });
});
