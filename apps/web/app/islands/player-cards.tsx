import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { LivePlayerCards, PlayerCardList } from "../skills/player-card";
import type { PlayerCardsProps } from "../skills/player-card";

function PlayerCardsIsland(props: PlayerCardsProps): ReactNode {
  return <LivePlayerCards {...props} />;
}

export default defineIsland({
  component: PlayerCardsIsland,
  fallback: PlayerCardList,
  name: "PlayerCards",
});
