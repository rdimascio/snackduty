import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { applyPlayerCardUpdate, subscribePlayerCardUpdates } from "./player-card-updates";

export interface PlayerCardArea {
  readonly area: string;
  readonly rating: number;
}

export interface PlayerCardEntry {
  readonly participantId: string;
  readonly label: string;
  readonly overall: number;
  readonly areas: readonly PlayerCardArea[];
}

const areaLabels: Readonly<Record<string, string>> = {
  hitting: "Hitting",
  bunting: "Bunting",
  baserunning: "Baserunning",
  infield: "Infield",
  outfield: "Outfield",
  "first-base": "First base",
  pitching: "Pitching",
  catching: "Catching",
  "baseball-iq": "Baseball IQ",
  mental: "Mental",
};

export function areaLabel(area: string): string {
  return Object.hasOwn(areaLabels, area) ? (areaLabels[area] ?? area) : area;
}

function PlayerCardItem({ player }: { player: PlayerCardEntry }): ReactNode {
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-semibold">{player.label}</p>
        <p className="text-sm">
          <span className="text-muted-foreground">Overall </span>
          <span className="text-2xl font-black">{player.overall}</span>
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {player.areas.map((entry) => (
          <div className="flex justify-between gap-2" key={entry.area}>
            <dt className="text-muted-foreground">{areaLabel(entry.area)}</dt>
            <dd className="font-semibold">{entry.rating}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export type PlayerCardsProps = {
  readonly players: readonly PlayerCardEntry[];
};

export function PlayerCardList({ players }: PlayerCardsProps): ReactNode {
  return (
    <ul className="mt-3 grid gap-4 sm:grid-cols-2">
      {players.map((player) => (
        <PlayerCardItem key={player.participantId} player={player} />
      ))}
    </ul>
  );
}

export function LivePlayerCards({
  players: initialPlayers,
  target,
}: PlayerCardsProps & { readonly target?: EventTarget }): ReactNode {
  const [players, setPlayers] = useState<readonly PlayerCardEntry[]>(initialPlayers);
  useEffect(
    () =>
      subscribePlayerCardUpdates(
        (update) => setPlayers((current) => applyPlayerCardUpdate(current, update)),
        target,
      ),
    [target],
  );
  return <PlayerCardList players={players} />;
}
