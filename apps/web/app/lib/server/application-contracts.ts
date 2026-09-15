import type { Sessions } from "@lesto/auth";
import type { Db } from "@lesto/db";
import type { z } from "zod";
import type {
  appleChallengeSchema,
  appleSignInInputSchema,
  AuthenticatedIdentity,
} from "@snackday/domain";

export type Clock = () => number;
export type SessionService = Pick<Sessions, "create" | "verify" | "revoke">;
export interface VerifiedProviderIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
}
export interface AppleIdentityVerifier {
  verify(identityToken: string, nonce: string): Promise<VerifiedProviderIdentity | undefined>;
}
export interface AuthenticationOptions {
  readonly db: Db;
  readonly sessions: Sessions;
  readonly clock: Clock;
  readonly appleVerifier?: AppleIdentityVerifier;
  readonly secureCookies: boolean;
}
export interface AuthenticationOperations {
  challenge(): Promise<z.infer<typeof appleChallengeSchema>>;
  signIn(
    input: z.infer<typeof appleSignInInputSchema>,
  ): Promise<{ readonly identity: AuthenticatedIdentity; readonly cookie: string } | undefined>;
  current(cookie: string | undefined): Promise<AuthenticatedIdentity | undefined>;
  logout(cookie: string | undefined): Promise<string>;
}
