import type { AnyLestoResponse, Context } from "@lesto/web";

import { kindLabel, localTimeOf, endInstant } from "./format";
import { loadSeasonSchedule, resolveSeasonScope } from "./schedule-data";
import type { OccurrenceView, SeasonScope } from "./schedule-data";

export const SCHEDULE_CSV_HEADER = [
  "Date",
  "Start",
  "End",
  "Time zone",
  "Event",
  "Type",
  "Location",
  "Status",
  "Cancellation reason",
  "Going",
  "Maybe",
  "Not going",
  "Snack duty",
  "Snack duty status",
] as const;

const FORMULA_PREFIX = /^[=+\-@\t\r]/u;

export function csvCell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function dutyStatusLabel(occurrence: OccurrenceView): string {
  if (occurrence.duties.length === 0) return "";
  return occurrence.duties.map((duty) => (duty.status === "open" ? "Open" : "Claimed")).join("; ");
}

export function scheduleCsv(occurrences: readonly OccurrenceView[], timeZone: string): string {
  const rows = occurrences.map((occurrence) => [
    occurrence.localDate,
    localTimeOf(occurrence.startsAt, timeZone),
    localTimeOf(endInstant(occurrence.startsAt, occurrence.durationMinutes), timeZone),
    timeZone,
    occurrence.title,
    kindLabel(occurrence.kind),
    occurrence.location ?? "",
    occurrence.cancelled ? "Cancelled" : "Scheduled",
    occurrence.cancelledReason ?? "",
    occurrence.counts.yes,
    occurrence.counts.maybe,
    occurrence.counts.no,
    occurrence.duties.map((duty) => duty.label).join("; "),
    dutyStatusLabel(occurrence),
  ]);
  return [SCHEDULE_CSV_HEADER, ...rows]
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\r\n")
    .concat("\r\n");
}

function csvResponse(body: string): AnyLestoResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="snackday-schedule.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: `﻿${body}`,
  };
}

export async function exportScheduleCsv(c: Context): Promise<AnyLestoResponse | undefined> {
  const scope = await resolveSeasonScope(c);
  if (scope.state !== "season" || !scope.team.canManage) return undefined;
  return exportForScope(scope);
}

async function exportForScope(scope: SeasonScope): Promise<AnyLestoResponse | undefined> {
  const schedule = await loadSeasonSchedule(scope);
  if (schedule === undefined) return undefined;
  return csvResponse(scheduleCsv(schedule.occurrences, scope.season.timeZone));
}
