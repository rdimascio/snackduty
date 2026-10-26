import { eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { resolveLessonAgeBand } from "@snackday/domain";
import type { Card } from "@snackday/skill-engine";

import type { Clock, SessionService as Sessions } from "../lib/server/application-contracts";
import { authenticatedAdult } from "../lib/server/identity";
import { participants } from "../lib/server/roster";
import { seasonLessonAgeBand, teamAccess } from "../lib/server/teams";
import {
  currentSeason,
  mayManageParticipant,
  seasonTimeZone,
  teamParticipantIds,
} from "../lessons/lessons";
import type { LessonResult } from "../lessons/lessons";
import {
  localDateIn,
  participantSkillEvents,
  rateParticipant,
  wholeYearsBetween,
} from "./skill-events";

export interface SkillCardServices {
  readonly db: Db;
  readonly clock: Clock;
}

export interface PlayerCard {
  readonly participantId: string;
  readonly card: Card;
}

const teamNotFound = { ok: false, status: 404, error: "team not found" } as const;
const participantNotFound = { ok: false, status: 404, error: "participant not found" } as const;

async function participantAgeYears(
  services: SkillCardServices,
  tx: Db,
  teamId: string,
  participantId: string,
): Promise<number> {
  const season = await currentSeason(tx, teamId);
  const participant = await tx
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  const birthDate = participant?.birthDate ?? null;
  if (birthDate === null) {
    return resolveLessonAgeBand(season === undefined ? undefined : seasonLessonAgeBand(season)).min;
  }
  return wholeYearsBetween(birthDate, localDateIn(services.clock(), seasonTimeZone(season)));
}

async function participantCard(
  services: SkillCardServices,
  tx: Db,
  teamId: string,
  participantId: string,
): Promise<Card> {
  const ageYears = await participantAgeYears(services, tx, teamId, participantId);
  return rateParticipant(await participantSkillEvents(tx, participantId), ageYears);
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
    if (!(await mayManageParticipant(tx, personId, access.team.id, participantId))) {
      return participantNotFound;
    }
    return {
      ok: true,
      value: await participantCard(services, tx, access.team.id, participantId),
    };
  });
}

export async function loadPlayerCards(
  services: SkillCardServices,
  personId: string,
  teamId: string,
): Promise<readonly PlayerCard[]> {
  try {
    return await services.db.transaction(async (tx) => {
      const access = await teamAccess(tx, teamId, personId);
      if (access === undefined) return [];
      const cards: PlayerCard[] = [];
      for (const participantId of await teamParticipantIds(tx, access.team.id)) {
        if (await mayManageParticipant(tx, personId, access.team.id, participantId)) {
          cards.push({
            participantId,
            card: await participantCard(services, tx, access.team.id, participantId),
          });
        }
      }
      return cards;
    });
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
