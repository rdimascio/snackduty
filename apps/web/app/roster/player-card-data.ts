import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";

import type { AppServices } from "../lib/server/app-services";
import { authenticatedAdult, people } from "../lib/server/identity";
import { participants } from "../lib/server/roster";
import { seasons, teamAccess } from "../lib/server/teams";
import type { LessonServices } from "../lessons/lessons";
import type { PlayerCardEntry } from "../skills/player-card";
import { readSkillCard } from "../skills/skill-card";
import { rosterHref } from "./roster-data";

export type PlayerCardPageData =
  | { readonly state: "signed-out" }
  | { readonly state: "not-found" }
  | {
      readonly state: "card";
      readonly teamName: string;
      readonly rosterHref: string;
      readonly player: PlayerCardEntry;
    };

async function childDisplayName(db: Db, participantId: string): Promise<string | undefined> {
  const participant = await db
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  if (participant === undefined) return undefined;
  const person = await db.select().from(people).where(eq(people.id, participant.personId)).get();
  return person?.displayName;
}

async function activeSeasonOfTeam(
  db: Db,
  teamId: string,
  seasonId: string | undefined,
): Promise<string | undefined> {
  if (seasonId === undefined) return undefined;
  const season = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, seasonId), eq(seasons.teamId, teamId), eq(seasons.status, "active")))
    .get();
  return season?.id;
}

export async function loadPlayerCardPage(
  services: AppServices,
  lessons: LessonServices | undefined,
  cookie: string | undefined,
  target: {
    readonly teamId: string | undefined;
    readonly seasonId: string | undefined;
    readonly participantId: string;
  },
): Promise<PlayerCardPageData> {
  const identity = await authenticatedAdult(services.db, services.sessions, cookie);
  if (identity === undefined) return { state: "signed-out" };

  if (lessons === undefined || target.teamId === undefined) return { state: "not-found" };

  const card = await readSkillCard(
    lessons,
    identity.person.id,
    target.teamId,
    target.participantId,
  );
  if (!card.ok) return { state: "not-found" };

  const access = await teamAccess(services.db, target.teamId, identity.person.id);
  if (access === undefined) return { state: "not-found" };
  const label = (await childDisplayName(services.db, target.participantId)) ?? "Player";
  const seasonId = await activeSeasonOfTeam(services.db, access.team.id, target.seasonId);

  return {
    state: "card",
    teamName: access.team.name,
    rosterHref: rosterHref(access.team.id, seasonId),
    player: {
      participantId: target.participantId,
      label,
      overall: card.value.overall,
      areas: card.value.areas.map(({ area, rating }) => ({ area, rating })),
    },
  };
}
