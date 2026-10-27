import { rulesV0, streakMultiplier } from "@snackday/skill-engine";
import type { Card } from "@snackday/skill-engine";

import type { AreaRating, PlayerCardData, PlayerStreak } from "./sample-player";

export type CardViewer = "guardian" | "coach";

export interface ReadablePlayer {
  readonly participantId: string;
  readonly label: string;
  readonly teamName: string;
  readonly viewer: CardViewer;
  readonly card: Card;
}

interface CardArea {
  readonly area: string;
  readonly short: string;
  readonly sources: readonly string[];
}

export const BALLPLAYER_CARD_AREAS: readonly CardArea[] = [
  { area: "Hitting", short: "HIT", sources: ["hitting", "bunting"] },
  { area: "Fielding", short: "FLD", sources: ["infield", "outfield", "first-base", "catching"] },
  { area: "Throwing", short: "THR", sources: ["pitching"] },
  { area: "Speed", short: "SPD", sources: ["baserunning"] },
  { area: "Baseball IQ", short: "IQ", sources: ["baseball-iq", "mental"] },
];

const DAY_MS = 86_400_000;

export const LIVE_STREAK_WINDOW_MS = 2 * DAY_MS;

function floorMean(values: readonly number[]): number {
  return Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function ballplayerAreas(card: Card): AreaRating[] {
  return BALLPLAYER_CARD_AREAS.flatMap(({ area, short, sources }) => {
    const ratings = card.areas
      .filter((entry) => sources.includes(entry.area))
      .map((entry) => entry.rating);
    return ratings.length === 0 ? [] : [{ area, short, rating: floorMean(ratings) }];
  });
}

function multiplierLabel(days: number): string | undefined {
  const multiplier = streakMultiplier(days, rulesV0.streak);
  return multiplier > 1 ? `${multiplier}x` : undefined;
}

export function currentStreak(card: Card, nowMs: number): PlayerStreak | undefined {
  const latest = card.skills.reduce<Card["skills"][number] | undefined>(
    (found, skill) =>
      found === undefined || Date.parse(skill.lastTrainedAt) > Date.parse(found.lastTrainedAt)
        ? skill
        : found,
    undefined,
  );
  if (latest === undefined || latest.streakAtLast < 1) return undefined;
  const age = nowMs - Date.parse(latest.lastTrainedAt);
  if (age < 0 || age > LIVE_STREAK_WINDOW_MS) return undefined;
  const multiplier = multiplierLabel(latest.streakAtLast);
  return multiplier === undefined
    ? { days: latest.streakAtLast }
    : { days: latest.streakAtLast, multiplier };
}

function captionFor(player: ReadablePlayer): string {
  return player.viewer === "guardian"
    ? `${player.teamName} · Your player`
    : `${player.teamName} · Coach view · Read only`;
}

export function ballplayerCard(player: ReadablePlayer, nowMs: number): PlayerCardData {
  const streak = currentStreak(player.card, nowMs);
  return {
    name: player.label,
    overall: player.card.overall,
    areas: ballplayerAreas(player.card),
    caption: captionFor(player),
    ...(streak === undefined ? {} : { streak }),
  };
}
