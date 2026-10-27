import { durationBetween } from "./format";
import type { AttendanceStatus, EventKind, Weekday } from "./format";

export interface ApiReply {
  readonly status: number;
  readonly json: unknown;
}

export type ApiSender = (method: "GET" | "POST", url: string, body?: unknown) => Promise<ApiReply>;

export const browserSend: ApiSender = async (method, url, body) => {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};

export type ActionResult<T = undefined> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const OFFLINE_MESSAGE = "Snackday could not be reached. Check your connection and try again.";

function field(json: unknown, key: string): unknown {
  return typeof json === "object" && json !== null
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

export function failureMessage(reply: ApiReply): string {
  const code = field(reply.json, "code");
  const error = field(reply.json, "error");
  if (reply.status === 401) return "Your session expired. Sign in again to continue.";
  if (reply.status === 404) return "This event is no longer available to this account.";
  if (reply.status === 409) {
    if (code === "request_id_conflict") return "Change the form and submit it as a new request.";
    if (code === "event_occurrence_unavailable") {
      return "Snack duty needs an event that has not started yet.";
    }
    return "This event can no longer accept changes.";
  }
  if (reply.status === 422 && typeof error === "string" && typeof code === "string") return error;
  if (reply.status === 400 || reply.status === 422) {
    return "Review the event information and try again.";
  }
  if (reply.status === 429) return "Too many requests. Wait a moment, then try again.";
  return "Snackday is unavailable right now. Try again shortly.";
}

async function attempt(
  send: ApiSender,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<ApiReply | undefined> {
  try {
    return await send(method, url, body);
  } catch {
    return undefined;
  }
}

function teamPath(teamId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}`;
}

export interface EventFormValues {
  readonly title: string;
  readonly kind: EventKind;
  readonly location: string;
  readonly notes: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly repeat: "none" | "weekly";
  readonly weekdays: readonly Weekday[];
  readonly untilDate: string;
  readonly snackDuty: boolean;
  readonly snackLabel: string;
  readonly snackInstructions: string;
}

export type EventFormField =
  | "title"
  | "location"
  | "notes"
  | "date"
  | "endTime"
  | "weekdays"
  | "untilDate"
  | "snackLabel"
  | "snackInstructions";

export interface EventSeriesInput {
  readonly title: string;
  readonly kind: EventKind;
  readonly location?: string;
  readonly notes?: string;
  readonly schedule: {
    readonly timeZone: string;
    readonly localTime: string;
    readonly durationMinutes: number;
    readonly frequency: "once" | "weekly";
    readonly byWeekday?: readonly Weekday[];
    readonly startDate: string;
    readonly untilDate?: string;
  };
}

export interface CreateEventInput extends EventSeriesInput {
  readonly snackDuty?: { readonly label: string; readonly instructions?: string };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function buildEventInput(
  values: EventFormValues,
  timeZone: string,
  mode: "create" | "edit",
):
  | { readonly ok: true; readonly input: CreateEventInput }
  | { readonly ok: false; readonly errors: Partial<Record<EventFormField, string>> } {
  const errors: Partial<Record<EventFormField, string>> = {};
  const title = values.title.trim();
  if (title === "") errors.title = "Enter a title.";
  else if (title.length > 200) errors.title = "Keep the title under 200 characters.";
  const location = optionalText(values.location);
  if (location !== undefined && location.length > 200) {
    errors.location = "Keep the location under 200 characters.";
  }
  const notes = optionalText(values.notes);
  if (notes !== undefined && notes.length > 2_000) {
    errors.notes = "Keep the notes under 2,000 characters.";
  }
  if (!DATE_PATTERN.test(values.date)) errors.date = "Choose a date.";
  const duration = durationBetween(values.startTime, values.endTime);
  if (duration === undefined || duration < 5) {
    errors.endTime = "End the event at least 5 minutes after it starts, on the same day.";
  }
  const weekly = values.repeat === "weekly";
  if (weekly) {
    if (values.weekdays.length === 0) errors.weekdays = "Choose at least one day.";
    if (!DATE_PATTERN.test(values.untilDate)) errors.untilDate = "Choose the last date.";
    else if (DATE_PATTERN.test(values.date) && values.untilDate < values.date) {
      errors.untilDate = "The last date cannot be before the first date.";
    }
  }
  const withSnack = mode === "create" && !weekly && values.snackDuty;
  const snackLabel = values.snackLabel.trim();
  const snackInstructions = optionalText(values.snackInstructions);
  if (withSnack) {
    if (snackLabel === "") errors.snackLabel = "Name the snack duty.";
    else if (snackLabel.length > 120) {
      errors.snackLabel = "Keep the duty name under 120 characters.";
    }
    if (snackInstructions !== undefined && snackInstructions.length > 2_000) {
      errors.snackInstructions = "Keep the instructions under 2,000 characters.";
    }
  }
  if (Object.keys(errors).length > 0 || duration === undefined) return { ok: false, errors };

  return {
    ok: true,
    input: {
      title,
      kind: values.kind,
      ...(location === undefined ? {} : { location }),
      ...(notes === undefined ? {} : { notes }),
      schedule: {
        timeZone,
        localTime: values.startTime,
        durationMinutes: duration,
        frequency: weekly ? "weekly" : "once",
        ...(weekly ? { byWeekday: [...values.weekdays] } : {}),
        startDate: values.date,
        ...(weekly ? { untilDate: values.untilDate } : {}),
      },
      ...(withSnack
        ? {
            snackDuty: {
              label: snackLabel,
              ...(snackInstructions === undefined ? {} : { instructions: snackInstructions }),
            },
          }
        : {}),
    },
  };
}

export interface CreatedEvent {
  readonly firstOccurrenceId: string | undefined;
}

export async function createEvent(
  teamId: string,
  seasonId: string,
  input: CreateEventInput,
  requestId: string,
  send: ApiSender = browserSend,
): Promise<ActionResult<CreatedEvent>> {
  const reply = await attempt(
    send,
    "POST",
    `${teamPath(teamId)}/seasons/${encodeURIComponent(seasonId)}/events`,
    { ...input, requestId },
  );
  if (reply === undefined) return { ok: false, message: OFFLINE_MESSAGE };
  if (reply.status !== 201) return { ok: false, message: failureMessage(reply) };
  const occurrences = field(reply.json, "occurrences");
  const first = Array.isArray(occurrences) ? field(occurrences[0], "id") : undefined;
  return { ok: true, value: { firstOccurrenceId: typeof first === "string" ? first : undefined } };
}

export async function updateSeries(
  teamId: string,
  seriesId: string,
  input: EventSeriesInput,
  send: ApiSender = browserSend,
): Promise<ActionResult> {
  const reply = await attempt(
    send,
    "POST",
    `${teamPath(teamId)}/events/${encodeURIComponent(seriesId)}/update`,
    input,
  );
  if (reply === undefined) return { ok: false, message: OFFLINE_MESSAGE };
  if (reply.status !== 200) return { ok: false, message: failureMessage(reply) };
  return { ok: true, value: undefined };
}

export async function cancelOccurrence(
  teamId: string,
  occurrenceId: string,
  reason: string,
  send: ApiSender = browserSend,
): Promise<ActionResult> {
  const trimmed = reason.trim();
  if (trimmed === "") return { ok: false, message: "Tell families why this event is cancelled." };
  if (trimmed.length > 500) return { ok: false, message: "Keep the reason under 500 characters." };
  const reply = await attempt(
    send,
    "POST",
    `${teamPath(teamId)}/occurrences/${encodeURIComponent(occurrenceId)}/cancel`,
    { reason: trimmed },
  );
  if (reply === undefined) return { ok: false, message: OFFLINE_MESSAGE };
  if (reply.status !== 200) return { ok: false, message: failureMessage(reply) };
  return { ok: true, value: undefined };
}

export interface AttendanceOption {
  readonly participantId: string;
  readonly displayName: string;
  readonly status?: AttendanceStatus | undefined;
}

export interface AttendanceView {
  readonly counts: { readonly yes: number; readonly maybe: number; readonly no: number };
  readonly entries: readonly {
    readonly participantId: string;
    readonly displayName: string;
    readonly status: AttendanceStatus;
  }[];
  readonly responseOptions: readonly AttendanceOption[];
}

function isAttendanceView(value: unknown): value is AttendanceView {
  const counts = field(value, "counts");
  return (
    typeof field(counts, "yes") === "number" &&
    Array.isArray(field(value, "entries")) &&
    Array.isArray(field(value, "responseOptions"))
  );
}

export async function readAttendance(
  teamId: string,
  occurrenceId: string,
  send: ApiSender = browserSend,
): Promise<ActionResult<AttendanceView>> {
  const reply = await attempt(
    send,
    "GET",
    `${teamPath(teamId)}/occurrences/${encodeURIComponent(occurrenceId)}/attendance`,
  );
  if (reply === undefined) return { ok: false, message: OFFLINE_MESSAGE };
  if (reply.status !== 200) return { ok: false, message: failureMessage(reply) };
  const attendance = field(reply.json, "attendance");
  if (!isAttendanceView(attendance)) {
    return { ok: false, message: "Snackday sent an unexpected answer. Refresh the page." };
  }
  return { ok: true, value: attendance };
}

export async function recordAttendance(
  teamId: string,
  occurrenceId: string,
  participantId: string,
  status: AttendanceStatus,
  send: ApiSender = browserSend,
): Promise<ActionResult<AttendanceView>> {
  const reply = await attempt(
    send,
    "POST",
    `${teamPath(teamId)}/occurrences/${encodeURIComponent(occurrenceId)}/attendance`,
    { participantId, status },
  );
  if (reply === undefined) return { ok: false, message: OFFLINE_MESSAGE };
  if (reply.status !== 200) return { ok: false, message: failureMessage(reply) };
  return readAttendance(teamId, occurrenceId, send);
}
