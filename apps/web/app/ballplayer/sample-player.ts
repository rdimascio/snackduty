export interface AreaRating {
  readonly area: string;
  readonly short: string;
  readonly rating: number;
}

export interface PlayerCardData {
  readonly name: string;
  readonly number: number;
  readonly position: string;
  readonly level: string;
  readonly bats: string;
  readonly throws: string;
  readonly overall: number;
  readonly progressToNext: number;
  readonly streakDays: number;
  readonly streakMultiplier: string;
  readonly areas: readonly AreaRating[];
}

export const samplePlayer: PlayerCardData = {
  name: "Sample Player",
  number: 7,
  position: "SS",
  level: "14U",
  bats: "R",
  throws: "R",
  overall: 84,
  progressToNext: 62,
  streakDays: 12,
  streakMultiplier: "1.5x",
  areas: [
    { area: "Hitting", short: "HIT", rating: 86 },
    { area: "Fielding", short: "FLD", rating: 88 },
    { area: "Throwing", short: "THR", rating: 81 },
    { area: "Speed", short: "SPD", rating: 79 },
    { area: "Baseball IQ", short: "IQ", rating: 85 },
  ],
};
