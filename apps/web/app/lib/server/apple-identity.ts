import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { AppleIdentityVerifier, VerifiedProviderIdentity } from "./application-contracts";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = new URL("https://appleid.apple.com/auth/keys");

export interface AppleIdentityVerifierOptions {
  readonly audience: string;
  readonly issuer?: string;
  readonly keyResolver?: JWTVerifyGetKey;
  readonly clock?: () => number;
}

function verifiedEmail(payload: Record<string, unknown>): {
  email?: string;
  emailVerified: boolean;
} {
  const isVerified = payload["email_verified"] === true || payload["email_verified"] === "true";
  const email =
    typeof payload["email"] === "string" ? payload["email"].trim().toLowerCase() : undefined;
  return isVerified && email !== undefined && email.length > 0
    ? { email, emailVerified: true }
    : { emailVerified: false };
}

/** Verify an Apple ID token against a fixed issuer, audience, clock and nonce claim. */
export function createAppleIdentityVerifier(
  options: AppleIdentityVerifierOptions,
): AppleIdentityVerifier {
  if (options.audience.trim().length === 0) throw new Error("Apple audience is required.");

  const issuer = options.issuer ?? APPLE_ISSUER;
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(APPLE_JWKS);

  return {
    async verify(identityToken, expectedNonceClaim) {
      try {
        const { payload } = await jwtVerify(identityToken, keyResolver, {
          algorithms: ["RS256"],
          issuer,
          audience: options.audience,
          currentDate: new Date((options.clock ?? Date.now)()),
          maxTokenAge: "10m",
        });

        if (
          typeof payload.sub !== "string" ||
          payload.sub.length === 0 ||
          typeof payload.exp !== "number" ||
          payload["nonce"] !== expectedNonceClaim
        ) {
          return undefined;
        }

        const email = verifiedEmail(payload);
        return {
          issuer,
          subject: payload.sub,
          ...email,
        } satisfies VerifiedProviderIdentity;
      } catch (error) {
        if (error instanceof joseErrors.JOSEError) return undefined;
        throw error;
      }
    },
  };
}
