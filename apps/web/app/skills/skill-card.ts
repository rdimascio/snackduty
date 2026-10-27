import { eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import type { Card } from "@snackday/skill-engine";

import type { SessionService as Sessions } from "../lib/server/application-contracts";
import { authenticatedAdult, people } from "../lib/server/identity";
import { participants } from "../lib/server/roster";
import { listAccessibleTeams } from "../lib/server/team-reads";
import { teamAccess } from "../lib/server/teams";
import { mayReadParticipantCard, teamParticipantIds } from "../lessons/lessons";
import type { LessonResult } from "../lessons/lessons";
import { participantSkillEvents, rateParticipant } from "./skill-events";

export interface SkillCardServices {
  readonly db: Db;
}

export interface PlayerCard {
  readonly participantId: string;
  readonly teamId: string;
  readonly label: string;
  readonly card: Card;
}

const teamNotFound = { ok: false, status: 404, error: "team not found" } as const;
const participantNotFound = { ok: false, status: 404, error: "participant not found" } as const;

async function participantCard(tx: Db, participantId: string): Promise<Card> {
  return rateParticipant(await participantSkillEvents(tx, participantId));
}

async function participantLabel(tx: Db, participantId: string): Promise<string | undefined> {
  const participant = await tx
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  if (participant === undefined) return undefined;
  const person = await tx.select().from(people).where(eq(people.id, participant.personId)).get();
  return person?.displayName;
}

export async function readSkillCard(
  services: SkillCardServices,
  personId: string,
  teamId: string,
  participantId: string,
): Promise<LessonResult<Card>> {
  return services.db.transaction(async (tx) => {
    const access = await teamAccess(tx, teamId, personId);
    if (access === undefined) return teamNotFound;
    if (!(await mayReadParticipantCard(tx, personId, access.team.id, participantId))) {
      return participantNotFound;
    }
    return {
      ok: true,
      value: await participantCard(tx, participantId),
    };
  });
}

async function readablePlayerCards(tx: Db, personId: string): Promise<PlayerCard[]> {
  const cards: PlayerCard[] = [];
  const carded = new Set<string>();
  for (const { team } of await listAccessibleTeams(tx, personId)) {
    for (const participantId of await teamParticipantIds(tx, team.id)) {
      if (carded.has(participantId)) continue;
      if (!(await mayReadParticipantCard(tx, personId, team.id, participantId))) continue;
      carded.add(participantId);
      cards.push({
        participantId,
        teamId: team.id,
        label: (await participantLabel(tx, participantId)) ?? `Player ${cards.length + 1}`,
        card: await participantCard(tx, participantId),
      });
    }
  }
  return cards;
}

export async function loadPlayerCards(
  services: SkillCardServices,
  personId: string,
): Promise<readonly PlayerCard[]> {
  try {
    return await services.db.transaction((tx) => readablePlayerCards(tx, personId));
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "skills.player_cards_unavailable" }));
    return [];
  }
}

async function readParticipantSkillCard(
  c: Context<"/api/teams/:teamId/participants/:participantId/skill-card">,
  services: SkillCardServices,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(services.db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json({ error: "authentication required" }, 401);
  const outcome = await readSkillCard(
    services,
    identity.person.id,
    c.param("teamId"),
    c.param("participantId"),
  );
  return outcome.ok ? c.json(outcome.value) : c.json({ error: outcome.error }, outcome.status);
}

export function registerSkillCardRoutes(
  app: Lesto,
  sessions: Sessions,
  services: SkillCardServices,
) {
  return app.get("/api/teams/:teamId/participants/:participantId/skill-card", (c) =>
    readParticipantSkillCard(c, services, sessions),
  );
}
