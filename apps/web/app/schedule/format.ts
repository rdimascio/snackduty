export type EventKind = "practice" | "game" | "other";

export type AttendanceStatus = "yes" | "no" | "maybe";

export const EVENT_KINDS: readonly { readonly value: EventKind; readonly label: string }[] = [
  { value: "practice", label: "Practice" },
  { value: "game", label: "Game" },
  { value: "other", label: "Other" },
];

export const WEEKDAYS = [
  { value: "monday", label: "Monday", short: "Mon" },
  { value: "tuesday", label: "Tuesday", short: "Tue" },
  { value: "wednesday", label: "Wednesday", short: "Wed" },
  { value: "thursday", label: "Thursday", short: "Thu" },
  { value: "friday", label: "Friday", short: "Fri" },
  { value: "saturday", label: "Saturday", short: "Sat" },
  { value: "sunday", label: "Sunday", short: "Sun" },
] as const;

export type Weekday = (typeof WEEKDAYS)[number]["value"];

export const ATTENDANCE_CHOICES: readonly {
  readonly value: AttendanceStatus;
  readonly label: string;
}[] = [
  { value: "yes", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "Not going" },
];

const MINUTE_MS = 60_000;

export function kindLabel(kind: string): string {
  return EVENT_KINDS.find((entry) => entry.value === kind)?.label ?? "Event";
}

export function attendanceLabel(status: AttendanceStatus | undefined): string {
  return ATTENDANCE_CHOICES.find((entry) => entry.value === status)?.label ?? "No response";
}

export function countsSummary(counts: {
  readonly yes: number;
  readonly maybe: number;
  readonly no: number;
}): string {
  return `${counts.yes} going · ${counts.maybe} maybe · ${counts.no} not going`;
}

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...options });
}

export function localDateOf(instant: string, timeZone: string): string {
  const parts = formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function localTimeOf(instant: string, timeZone: string): string {
  const parts = formatter(timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

export function timeLabel(instant: string, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

export function endInstant(startsAt: string, durationMinutes: number): string {
  return new Date(Date.parse(startsAt) + durationMinutes * MINUTE_MS).toISOString();
}

export function timeRangeLabel(
  startsAt: string,
  durationMinutes: number,
  timeZone: string,
): string {
  return `${timeLabel(startsAt, timeZone)} – ${timeLabel(endInstant(startsAt, durationMinutes), timeZone)}`;
}

export function dayLabel(localDate: string): string {
  return formatter("UTC", { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${localDate}T12:00:00Z`),
  );
}

export function longDateLabel(localDate: string): string {
  return formatter("UTC", { month: "long", day: "numeric", year: "numeric" }).format(
    new Date(`${localDate}T12:00:00Z`),
  );
}

export function weekdayOfDate(localDate: string): Weekday {
  const index = (new Date(`${localDate}T12:00:00Z`).getUTCDay() + 6) % 7;
  return WEEKDAYS[index]?.value ?? "monday";
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

export function repeatSummary(series: {
  readonly frequency: string;
  readonly byWeekday?: readonly string[] | undefined;
  readonly untilDate?: string | undefined;
}): string {
  if (series.frequency !== "weekly") return "One-time event";
  const days = WEEKDAYS.filter((day) => series.byWeekday?.includes(day.value)).map(
    (day) => day.label,
  );
  const until = series.untilDate === undefined ? "" : ` until ${longDateLabel(series.untilDate)}`;
  return `Repeats weekly on ${joinWords(days)}${until}`;
}

export function durationBetween(startTime: string, endTime: string): number | undefined {
  const minutes = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    if (match === null) return undefined;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = minutes(startTime);
  const end = minutes(endTime);
  if (start === undefined || end === undefined || end <= start) return undefined;
  return end - start;
}

export function addMinutesToTime(time: string, minutes: number): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (match === null) return time;
  const total = Math.min(Number(match[1]) * 60 + Number(match[2]) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export interface ScheduleSelection {
  readonly teamId?: string | undefined;
  readonly seasonId?: string | undefined;
}

export function scheduleHref(path: string, selection: ScheduleSelection): string {
  const query = new URLSearchParams();
  if (selection.teamId !== undefined) query.set("team", selection.teamId);
  if (selection.seasonId !== undefined) query.set("season", selection.seasonId);
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
}
