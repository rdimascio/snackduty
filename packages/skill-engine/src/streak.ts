import type { Rules } from "./rules";

const MS_PER_DAY = 86_400_000;

export function dayNumber(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

interface TrainingDay {
  readonly day: number;
  readonly length: number;
  readonly lastBridged: number | undefined;
}

export interface StreakTimeline {
  readonly on: (localDate: string) => number;
}

function canBridge(
  missedDay: number,
  lastBridged: number | undefined,
  windowDays: number,
): boolean {
  return lastBridged === undefined || missedDay - lastBridged > windowDays;
}

function advance(previous: TrainingDay | undefined, day: number, windowDays: number): TrainingDay {
  if (previous === undefined) {
    return { day, length: 1, lastBridged: undefined };
  }
  const missed = day - previous.day - 1;
  if (missed === 0) {
    return { day, length: previous.length + 1, lastBridged: previous.lastBridged };
  }
  const restDayCandidate = previous.day + 1;
  if (missed === 1 && canBridge(restDayCandidate, previous.lastBridged, windowDays)) {
    return { day, length: previous.length + 1, lastBridged: restDayCandidate };
  }
  return { day, length: 1, lastBridged: previous.lastBridged };
}

export function buildStreakTimeline(
  trainingDates: readonly string[],
  restDay: Rules["restDay"],
): StreakTimeline {
  const days = [...new Set(trainingDates.map((date) => dayNumber(date)))].toSorted((a, b) => a - b);
  const timeline: TrainingDay[] = [];
  for (const day of days) {
    timeline.push(advance(timeline.at(-1), day, restDay.windowDays));
  }

  const byDay = new Map(timeline.map((entry) => [entry.day, entry]));

  return {
    on(localDate) {
      const day = dayNumber(localDate);
      const training = byDay.get(day);
      if (training) {
        return training.length;
      }
      const last = timeline.findLast((entry) => entry.day < day);
      if (!last) {
        return 0;
      }
      const missed = day - last.day - 1;
      if (missed === 0) {
        return last.length;
      }
      if (missed === 1 && canBridge(last.day + 1, last.lastBridged, restDay.windowDays)) {
        return last.length;
      }
      return 0;
    },
  };
}

export function streakMultiplier(streakDays: number, table: Rules["streak"]): number {
  let multiplier = table[0]?.multiplier ?? 1;
  for (const row of table) {
    if (streakDays >= row.minDays) {
      multiplier = row.multiplier;
    }
  }
  return multiplier;
}
