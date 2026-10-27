export type CardTier = "diamond" | "gold" | "silver" | "bronze" | "rookie";

const TIER_FLOORS: readonly (readonly [CardTier, number])[] = [
  ["diamond", 85],
  ["gold", 80],
  ["silver", 75],
  ["bronze", 65],
];

export function cardTier(overall: number): CardTier {
  return TIER_FLOORS.find(([, floor]) => overall >= floor)?.[0] ?? "rookie";
}
