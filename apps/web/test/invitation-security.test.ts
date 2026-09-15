import type { Db } from "@lesto/db";
import { describe, expect, it } from "vitest";

import { invitationRecipientMatches } from "../app/lib/server/invitations";

const unusedDb = {} as Db;

describe("invitation recipient binding", () => {
  it("matches a confirmed person by stable person id only", async () => {
    const noEmails = () => Promise.resolve([]);
    expect(
      await invitationRecipientMatches(
        unusedDb,
        { kind: "confirmed_person", personId: "person_recipient" },
        "person_recipient",
        noEmails,
      ),
    ).toBe(true);
    expect(
      await invitationRecipientMatches(
        unusedDb,
        { kind: "confirmed_person", personId: "person_recipient" },
        "person_forwarded",
        noEmails,
      ),
    ).toBe(false);
  });

  it("matches only a provider-verified email claim for the signed-in person", async () => {
    const verifiedEmails = (_db: Db, personId: string) =>
      Promise.resolve(
        personId === "person_recipient" ? ["other@example.test", "recipient@example.test"] : [],
      );

    expect(
      await invitationRecipientMatches(
        unusedDb,
        { kind: "verified_email", email: "recipient@example.test" },
        "person_recipient",
        verifiedEmails,
      ),
    ).toBe(true);
    expect(
      await invitationRecipientMatches(
        unusedDb,
        { kind: "verified_email", email: "recipient@example.test" },
        "person_forwarded",
        verifiedEmails,
      ),
    ).toBe(false);
  });
});
