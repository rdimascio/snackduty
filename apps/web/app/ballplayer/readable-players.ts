import type { Db } from "@lesto/db";

import { mayManageParticipant } from "../lessons/lessons";
import { listAccessibleTeams } from "../lib/server/team-reads";
import { readPlayerCards } from "../skills/skill-card";
import type { PlayerCard } from "../skills/skill-card";
import type { CardViewer, ReadablePlayer } from "./real-player";

async function viewerOf(tx: Db, personId: string, card: PlayerCard): Promise<CardViewer> {
  return (await mayManageParticipant(tx, personId, card.teamId, card.participantId))
    ? "guardian"
    : "coach";
}

export async function loadReadablePlayers(
  db: Db,
  personId: string,
): Promise<readonly ReadablePlayer[]> {
  const cards = await readPlayerCards({ db }, personId);
  if (cards.length === 0) return [];
  const teamNames = new Map<string, string>(
    (await listAccessibleTeams(db, personId)).map(({ team }) => [team.id, team.name]),
  );
  return db.transaction(async (tx) => {
    const players: ReadablePlayer[] = [];
    for (const card of cards) {
      const teamName = teamNames.get(card.teamId);
      if (teamName === undefined) continue;
      players.push({
        participantId: card.participantId,
        label: card.label,
        teamName,
        viewer: await viewerOf(tx, personId, card),
        card: card.card,
      });
    }
    return players;
  });
}
