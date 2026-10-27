import type { ReactNode } from "react";

import { AreaRadar } from "./area-radar";
import { cardTier } from "./card-tier";
import type { AreaRating, PlayerCardData, PlayerStreak } from "./sample-player";

function SeamPattern(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className="card-seams pointer-events-none absolute -top-24 -right-28 size-80"
      viewBox="0 0 200 200"
    >
      <circle className="seam-ball" cx="100" cy="100" r="96" />
      <path className="seam-line" d="M58 14 C 92 58, 92 142, 58 186" />
      <path className="seam-line" d="M142 14 C 108 58, 108 142, 142 186" />
      <path className="seam-stitch" d="M58 14 C 92 58, 92 142, 58 186" />
      <path className="seam-stitch" d="M142 14 C 108 58, 108 142, 142 186" />
    </svg>
  );
}

function FlameIcon(): ReactNode {
  return (
    <svg aria-hidden="true" className="size-4 fill-current" viewBox="0 0 16 16">
      <path d="M8.6 1c.3 2.2-.9 3.4-2 4.6C5.5 6.8 4.5 8 4.5 10a3.5 3.5 0 0 0 7 0c0-1.3-.5-2.2-1.1-3 .1 1-.3 1.8-1 2.2.2-2.6-.3-5.9-0.8-8.2Z" />
    </svg>
  );
}

function StatCell({ area, isTop }: { area: AreaRating; isTop: boolean }): ReactNode {
  return (
    <div className="flex flex-col-reverse items-center gap-1">
      <dt className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
        <span className="sr-only">{area.area}</span>
        <span aria-hidden="true">{area.short}</span>
      </dt>
      <dd
        className={`m-0 font-display text-2xl leading-none font-bold tabular-nums ${isTop ? "foil-text" : ""}`}
      >
        {area.rating}
      </dd>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className="h-1.5 w-full overflow-hidden rounded-full"
      preserveAspectRatio="none"
      viewBox="0 0 100 1"
    >
      <rect className="bar-track" height="1" width="100" />
      <rect className="bar-fill" height="1" width={percent} />
    </svg>
  );
}

function PlayerLine({ player }: { player: PlayerCardData }): ReactNode {
  const parts = [
    player.number === undefined ? undefined : `#${player.number}`,
    player.level,
    player.bats === undefined || player.throws === undefined
      ? undefined
      : `B/T ${player.bats}/${player.throws}`,
  ].filter((part) => part !== undefined);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1.5 text-xs font-medium tracking-wider text-muted uppercase">
      {parts.join(" · ")}
    </p>
  );
}

function StreakBadge({ streak }: { streak: PlayerStreak }): ReactNode {
  return (
    <div className="flex items-center gap-1.5 text-(--tier-3)">
      <FlameIcon />
      <span className="text-xs font-semibold text-chalk">{`${streak.days}-day streak`}</span>
      {streak.multiplier === undefined ? null : (
        <span className="rounded bg-(--tier-1)/15 px-1.5 py-0.5 text-[0.65rem] font-bold tabular-nums">
          {streak.multiplier}
        </span>
      )}
    </div>
  );
}

function NextRating({ overall, percent }: { overall: number; percent: number }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs font-semibold tracking-[0.18em] text-muted uppercase">
        <span>Next {overall + 1}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <ProgressBar percent={percent} />
    </div>
  );
}

function CardFooter({ player }: { player: PlayerCardData }): ReactNode {
  if (player.streak === undefined && player.progressToNext === undefined) return null;
  return (
    <footer className="relative mt-4 grid grid-cols-[auto_1fr] items-center gap-5">
      {player.streak === undefined ? <span /> : <StreakBadge streak={player.streak} />}
      {player.progressToNext === undefined ? null : (
        <NextRating overall={player.overall} percent={player.progressToNext} />
      )}
    </footer>
  );
}

const STAT_COLUMNS: Readonly<Record<number, string>> = {
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
};

export function PlayerCard({ player }: { player: PlayerCardData }): ReactNode {
  const tier = cardTier(player.overall);
  const topRating = Math.max(...player.areas.map((area) => area.rating));

  return (
    <article
      aria-label={`Player card for ${player.name}`}
      className={`player-card tier-${tier} flex w-full max-w-sm flex-col`}
    >
      <div className="card-face relative isolate flex flex-1 flex-col overflow-hidden px-6 pt-6 pb-5">
        <SeamPattern />
        <div aria-hidden="true" className="card-shine pointer-events-none absolute inset-0" />

        <header className="relative flex items-start justify-between">
          <div className="flex flex-col items-start">
            <span className="foil-text font-display text-7xl leading-[0.8] font-extrabold tabular-nums">
              {player.overall}
            </span>
            <span className="mt-1.5 text-[0.65rem] font-bold tracking-[0.3em] text-chalk/80 uppercase">
              OVR
            </span>
            {player.position === undefined ? null : (
              <span className="mt-3 rounded-md border border-(--tier-1)/40 px-2 py-0.5 font-display text-lg leading-tight font-bold tracking-wider text-(--tier-3)">
                {player.position}
              </span>
            )}
          </div>
          <div className="flex flex-col items-end">
            <span className="tier-badge rounded-full px-2.5 py-1 text-[0.65rem] font-bold tracking-[0.25em] uppercase">
              {tier}
            </span>
            {player.number === undefined ? null : (
              <span
                aria-hidden="true"
                className="jersey-number mt-1 font-display text-[9rem] leading-[0.75] font-extrabold"
              >
                {player.number}
              </span>
            )}
          </div>
        </header>

        <div className="relative mt-4">
          <h2 className="font-display text-4xl leading-none font-extrabold tracking-wide break-words uppercase">
            {player.name}
          </h2>
          <PlayerLine player={player} />
        </div>

        <div className="relative mx-auto mt-3 w-56">
          <AreaRadar areas={player.areas} />
        </div>

        <dl
          className={`relative mt-1 grid ${STAT_COLUMNS[player.areas.length] ?? "grid-cols-5"} gap-1 rounded-2xl border border-line bg-black/20 px-2 py-3`}
        >
          {player.areas.map((area) => (
            <StatCell
              area={area}
              isTop={topRating > 0 && area.rating === topRating}
              key={area.short}
            />
          ))}
        </dl>

        <CardFooter player={player} />

        <p className="relative mt-auto pt-4 text-center text-xs font-semibold tracking-[0.3em] text-muted uppercase">
          {player.caption}
        </p>
      </div>
    </article>
  );
}
