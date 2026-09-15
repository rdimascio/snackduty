import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import { z } from "zod";

import type { ApplicationActor } from "./coordination-contracts";
import { accounts, people } from "./identity";

const applicationActorSchema = z.strictObject({
  accountId: z.string().trim().min(1),
  personId: z.string().trim().min(1),
});

/** Revalidate the exact session-resolved account/person pair inside an operation transaction. */
export async function activeApplicationActor(
  db: Db,
  candidate: ApplicationActor,
): Promise<ApplicationActor | undefined> {
  const parsed = applicationActorSchema.safeParse(candidate);
  if (!parsed.success) return undefined;

  const account = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, parsed.data.accountId),
        eq(accounts.personId, parsed.data.personId),
        eq(accounts.status, "active"),
      ),
    )
    .get();
  if (account === undefined) return undefined;

  const person = await db
    .select()
    .from(people)
    .where(and(eq(people.id, parsed.data.personId), eq(people.status, "active")))
    .get();

  return person === undefined ? undefined : parsed.data;
}
