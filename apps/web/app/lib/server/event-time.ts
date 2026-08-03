/**
 * Wall time → instant, in exactly one place.
 *
 * A series stores what the humans agreed to — "5:00pm Tuesdays, America/
 * Los_Angeles" — and each occurrence stores the UTC instant that wall time
 * means ON ITS OWN DATE (ADR 0009). Deriving per-date is what keeps a 5:00pm
 * practice at 5:00pm local across a DST transition: the instants on the two
 * sides differ by an hour, and that difference is correctness, not drift.
 *
 * The derivation uses only the Intl API (no timezone dependency): format a
 * candidate instant in the target zone, read the wall clock back, and correct
 * by the difference. One correction pass converges for every real wall time; a
 * wall time that a spring-forward gap SKIPS does not exist, and the second
 * pass lands on a deterministic nearby instant rather than throwing — a
 * practice scheduled at a time that does not exist that day still yields one
 * well-defined row instead of a crash.
 */

const ISO_LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** Whether `zone` names a real IANA time zone on this runtime. */
export function isValidTimeZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

const formatterByZone = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterByZone.get(zone);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterByZone.set(zone, formatter);
  return formatter;
}

/** The wall clock `zone` shows at `utcMs`, re-encoded as a UTC millisecond value. */
function wallClockAsUtcMs(zone: string, utcMs: number): number {
  const parts = zoneFormatter(zone).formatToParts(utcMs);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new Error(`Time zone formatting produced no ${type}.`);
    return Number(part.value);
  };

  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
}

/**
 * The UTC instant at which `zone` shows the wall clock `date`T`time` — ISO
 * string with millisecond precision, matching every other timestamp the app
 * stores. Ambiguous wall times (fall-back repeats an hour) and skipped ones
 * (spring-forward removes one) resolve deterministically via the two-pass
 * correction described in the header.
 */
export function instantFromWallTime(date: string, time: string, zone: string): string {
  if (!ISO_LOCAL_DATE.test(date)) throw new Error("Local date is not YYYY-MM-DD.");
  if (!ISO_LOCAL_TIME.test(time)) throw new Error("Local time is not HH:MM.");

  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  let candidate = wallAsUtc - (wallClockAsUtcMs(zone, wallAsUtc) - wallAsUtc);
  const remainder = wallAsUtc - wallClockAsUtcMs(zone, candidate);
  if (remainder !== 0) candidate += remainder;

  return new Date(candidate).toISOString();
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type WeekdayName = (typeof WEEKDAYS)[number];

/** The weekday of a civil date — pure calendar arithmetic, no zone involved. */
export function weekdayOf(date: string): WeekdayName {
  if (!ISO_LOCAL_DATE.test(date)) throw new Error("Local date is not YYYY-MM-DD.");
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  if (weekday === undefined) throw new Error("Weekday computation escaped its own range.");
  return weekday;
}

/** The civil date `days` after `date` — YYYY-MM-DD in, YYYY-MM-DD out. */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const iso = shifted.toISOString().slice(0, 10);
  return iso;
}

export interface ScheduleShape {
  readonly frequency: "once" | "weekly";
  readonly byWeekday?: readonly string[] | undefined;
  readonly startDate: string;
  readonly untilDate?: string | undefined;
}

/**
 * Every civil date a schedule names, ascending. `once` is its start date;
 * `weekly` is each selected weekday from start through until, INCLUSIVE on
 * both ends. Callers bound the result (MAX_SERIES_OCCURRENCES in events.ts)
 * — this function enumerates, it does not police.
 */
export function scheduleDates(schedule: ScheduleShape): string[] {
  if (schedule.frequency === "once") return [schedule.startDate];

  const until = schedule.untilDate;
  const selected = new Set(schedule.byWeekday ?? []);
  if (until === undefined || selected.size === 0) return [];

  const dates: string[] = [];
  for (let date = schedule.startDate; date <= until; date = addDays(date, 1)) {
    if (selected.has(weekdayOf(date))) dates.push(date);
  }
  return dates;
}
