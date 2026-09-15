import type { Db } from "@lesto/db";
import type { AuthenticationOperations, AuthenticationOptions } from "./application-contracts";

// Owned by lane B. Not registered in release composition until implemented.
export function createAuthentication(_options: AuthenticationOptions): AuthenticationOperations {
  throw new Error("Authentication is not configured.");
}

// Owned by lane B. An incomplete identity adapter never proves a recipient.
export async function verifiedRecipientEmails(
  _db: Db,
  _personId: string,
): Promise<readonly string[]> {
  return [];
}
