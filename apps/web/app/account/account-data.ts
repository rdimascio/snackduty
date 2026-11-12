import { and, eq } from "@lesto/db";

import type { AppServices } from "../lib/server/app-services";
import { authenticatedAdult, people } from "../lib/server/identity";
import { guardianRelationships, participants } from "../lib/server/roster";

export interface ManagedChild {
  readonly participantId: string;
  readonly name: string;
}

export type AccountPageData =
  | { readonly state: "signed-out" }
  | {
      readonly state: "account";
      readonly displayName: string;
      readonly children: readonly ManagedChild[];
    };

const MANAGE_PERMISSION = "participant.manage";

/** Children this adult may erase: every active guardian edge that grants manage. */
export async function loadAccountPage(
  services: AppServices,
  cookie: string | undefined,
): Promise<AccountPageData> {
  const identity = await authenticatedAdult(services.db, services.sessions, cookie);
  if (identity === undefined) return { state: "signed-out" };

  const edges = await services.db
    .select()
    .from(guardianRelationships)
    .where(
      and(
        eq(guardianRelationships.guardianPersonId, identity.person.id),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .all();
  const children: ManagedChild[] = [];
  for (const edge of edges) {
    if (!(JSON.parse(edge.permissions) as string[]).includes(MANAGE_PERMISSION)) continue;
    const participant = await services.db
      .select()
      .from(participants)
      .where(eq(participants.id, edge.participantId))
      .get();
    const person =
      participant === undefined
        ? undefined
        : await services.db.select().from(people).where(eq(people.id, participant.personId)).get();
    if (person !== undefined) {
      children.push({ participantId: edge.participantId, name: person.displayName });
    }
  }

  return {
    state: "account",
    displayName: identity.person.displayName,
    children: children.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}
