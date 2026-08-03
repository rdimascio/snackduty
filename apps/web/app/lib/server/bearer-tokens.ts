/**
 * The ONE bearer-token mint-and-hash pair. Invitation tokens and calendar
 * feed tokens share it, so "256 random bits, stored as SHA-256 hex ONLY" is a
 * property of the module, not a discipline each credential re-earns: the raw
 * token exists in the response that hands it to its holder and nowhere else.
 */

/** 32 random bytes as 64 lowercase hex characters. */
export function generateBearerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 hex digest a token is stored and looked up as. */
export async function hashBearerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
