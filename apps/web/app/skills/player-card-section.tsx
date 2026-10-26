import type { ReactNode } from "react";

import PlayerCardsIsland from "../islands/player-cards";
import type { PlayerCardEntry } from "./player-card";

export type { PlayerCardEntry } from "./player-card";

export function PlayerCardSection({ players }: { players: readonly PlayerCardEntry[] }): ReactNode {
  return (
    <section
      aria-label="Player card"
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
    >
      <p className="text-sm font-bold text-primary">Player card</p>
      <PlayerCardsIsland players={players} />
    </section>
  );
}
