/**
 * RFC 5545 iCalendar assembly, pure and dependency-free.
 *
 * Everything Snackday serves as `text/calendar` — the subscribable team feed
 * and the single-event export (calendar-feeds.ts) — is built here, so the
 * format rules live once:
 *
 *   - Content lines end CRLF and are FOLDED at 75 octets (not characters —
 *     folding never splits a UTF-8 sequence), continuations prefixed with one
 *     space, exactly as Apple Calendar and Google Calendar expect.
 *   - TEXT values escape backslash, semicolon, comma, and newline.
 *   - Instants are emitted as UTC (`...Z`). Every occurrence carries its own
 *     derived instant (ADR 0009), so local-time correctness never depends on
 *     a client honoring VTIMEZONE — a 5:00pm practice renders at 5:00pm on
 *     both sides of a DST transition because the instants differ.
 *   - A cancelled occurrence stays in the feed as `STATUS:CANCELLED` with a
 *     bumped `SEQUENCE`, so subscribed calendars withdraw it instead of
 *     silently keeping a phantom practice.
 *
 * PRIVACY: this module renders exactly the fields it is handed. The callers
 * decide what a feed may contain (never child data — ADR 0009); nothing here
 * reads the database.
 */

const CRLF = "\r\n";
const FOLD_LIMIT_OCTETS = 75;

const encoder = new TextEncoder();

/**
 * Drop every character RFC 5545 §3.1 forbids inside a content line: the C0
 * controls except HTAB, plus DEL. TEXT has no escape for them, so rendering
 * them is not an option — and a raw control in a served feed is also a
 * terminal-escape payload for anyone who `curl`s it. Expressed as a code-point
 * test so no source file has to carry raw control characters.
 */
function withoutControls(value: string): string {
  let kept = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\t" || (code >= 0x20 && code !== 0x7f)) kept += character;
  }
  return kept;
}

/**
 * A TEXT property value, escaped per RFC 5545 §3.3.11.
 *
 * Order is load-bearing: backslash first (escaping it after `;`/`,`/newline
 * would double-escape the escapes just written), newline last.
 *
 * Title, location, and notes are manager-typed free text whose validation only
 * trims the edges, so this is the boundary that keeps typed text INSIDE its
 * content line. A content line ends at ANY line break — CRLF, a lone LF, or a
 * lone CR — so all three collapse to the `\n` escape. A bare CR left raw lets a
 * title close the VEVENT and open attacker-chosen properties (a second
 * BEGIN:VEVENT, a UID that overwrites a real event already in a subscriber's
 * calendar, a VALARM) in every subscribed calendar.
 */
export function escapeIcsText(value: string): string {
  return withoutControls(
    value
      .replaceAll("\\", "\\\\")
      .replaceAll(";", "\\;")
      .replaceAll(",", "\\,")
      .replaceAll(/\r\n|\r|\n/gu, "\\n"),
  );
}

/**
 * One content line folded at 75 octets, continuations prefixed with a space.
 * Folding counts OCTETS and never splits inside a UTF-8 sequence: each code
 * point moves whole or starts the next fold.
 */
export function foldIcsLine(line: string): string {
  const folded: string[] = [];
  let current = "";
  let currentOctets = 0;
  // The first line may carry 75 octets; every continuation spends one on its
  // leading space.
  let budget = FOLD_LIMIT_OCTETS;

  for (const character of line) {
    const octets = encoder.encode(character).length;
    if (currentOctets + octets > budget) {
      folded.push(current);
      current = " ";
      currentOctets = 1;
      budget = FOLD_LIMIT_OCTETS;
    }
    current += character;
    currentOctets += octets;
  }
  folded.push(current);

  return folded.join(CRLF);
}

/** An ISO instant as the RFC 5545 UTC form: `20260308T010000Z`. */
export function icsUtcInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error("ICS instant is not an ISO timestamp.");
  return `${new Date(ms).toISOString().slice(0, 19).replaceAll(/[-:]/gu, "")}Z`;
}

export interface IcsEvent {
  /** Stable per-occurrence identity — clients track updates by it. */
  readonly uid: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly cancelled: boolean;
  /** Drives DTSTAMP/LAST-MODIFIED so polling clients see edits. */
  readonly updatedAt: string;
}

function eventLines(event: IcsEvent): string[] {
  const endsAtMs = Date.parse(event.startsAt) + event.durationMinutes * 60_000;
  const stamp = icsUtcInstant(event.updatedAt);

  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsUtcInstant(event.startsAt)}`,
    `DTEND:${icsUtcInstant(new Date(endsAtMs).toISOString())}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    ...(event.location === undefined ? [] : [`LOCATION:${escapeIcsText(event.location)}`]),
    ...(event.description === undefined ? [] : [`DESCRIPTION:${escapeIcsText(event.description)}`]),
    `LAST-MODIFIED:${stamp}`,
    // SEQUENCE distinguishes "still as published" from "revised"; cancellation
    // is the one revision an occurrence can carry today.
    `SEQUENCE:${event.cancelled ? 1 : 0}`,
    `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
  ];
}

export interface IcsCalendar {
  /** Shown by clients as the subscription's name (X-WR-CALNAME). */
  readonly name: string;
  readonly events: readonly IcsEvent[];
}

/** The complete serialized calendar, CRLF-terminated. */
export function icsCalendarText(calendar: IcsCalendar): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Snackday//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendar.name)}`,
    ...calendar.events.flatMap((event) => eventLines(event)),
    "END:VCALENDAR",
  ];

  return `${lines.map((line) => foldIcsLine(line)).join(CRLF)}${CRLF}`;
}
