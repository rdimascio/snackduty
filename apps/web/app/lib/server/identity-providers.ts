import type { Db } from "@lesto/db";

import { DEV_PERSONA_KEYS, ensureDevelopmentPersona } from "./identity";
import type { AdultIdentity, DevPersonaKey } from "./identity";

/**
 * A claim about who is at the keyboard that some provider has ALREADY
 * verified — credential checking (token signatures, nonce validation, the dev
 * allowlist) happens before a value of this shape exists. Resolution then maps
 * the provider-scoped stable `subject` onto exactly one Account/Person pair,
 * creating it once and only once: signing in again with the same subject must
 * never mint a duplicate identity.
 */
export interface VerifiedExternalIdentity {
  /** Which provider verified this identity (e.g. `"dev-persona"`; later `"apple"`). */
  readonly provider: string;
  /** The provider-scoped stable subject (a persona key today; Apple's `sub` later). */
  readonly subject: string;
  /**
   * Optional display name supplied by the provider. Some providers only send
   * it on first sign-in (Apple does), so resolution must not depend on it.
   */
  readonly displayName?: string;
}

export interface IdentityProvider {
  readonly id: string;
  /**
   * Resolve a verified identity to its one Account/Person pair, or
   * `undefined` when the claim is not this provider's to resolve.
   */
  resolveAdult(db: Db, identity: VerifiedExternalIdentity): Promise<AdultIdentity | undefined>;
}

function isDevPersonaKey(subject: string): subject is DevPersonaKey {
  return (DEV_PERSONA_KEYS as readonly string[]).includes(subject);
}

/**
 * The development persona provider — the ONLY implementation today. Its
 * subjects are the bounded persona allowlist; anything else resolves to
 * `undefined`, never to a fresh identity.
 */
export const devPersonaProvider: IdentityProvider = {
  id: "dev-persona",

  async resolveAdult(db, identity) {
    if (identity.provider !== "dev-persona" || !isDevPersonaKey(identity.subject)) {
      return undefined;
    }

    return ensureDevelopmentPersona(db, identity.subject);
  },
};

// Production Apple verification and stable issuer+subject linking live in
// apple-identity.ts and authentication.ts. Development identities remain
// deliberately separate and bounded here; they never impersonate an Apple
// subject or prove a recipient email.
