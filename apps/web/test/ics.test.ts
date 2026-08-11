import { describe, expect, it } from "vitest";

import { escapeIcsText, foldIcsLine, icsCalendarText, icsUtcInstant } from "../app/lib/server/ics";

const encoder = new TextEncoder();

// Written as code points so this file carries no raw control characters.
const CR = String.fromCodePoint(0x0d);
const TAB = String.fromCodePoint(0x09);
const BEL = String.fromCodePoint(0x07);
const ESC = String.fromCodePoint(0x1b);
const DEL = String.fromCodePoint(0x7f);

/** Split serialized ICS into physical lines; asserts CRLF-only line breaks. */
function physicalLines(text: string): string[] {
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  expect(text.replaceAll("\r\n", "")).not.toContain("\r");
  return text.slice(0, -2).split("\r\n");
}

/** Reverse RFC 5545 folding: a line starting with one space continues its predecessor. */
function unfold(lines: readonly string[]): string[] {
  const unfolded: string[] = [];
  for (const line of lines) {
    if (line.startsWith(" ") && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** How a lenient client reads the feed: unfold, then split on ANY line ending. */
function lenientLines(text: string): string[] {
  return unfold(text.split(/\r\n|\r|\n/u));
}

/** One event whose free-text fields are whatever a hostile manager typed. */
function calendarWithFreeText(event: {
  summary: string;
  location?: string;
  description?: string;
  name?: string;
}): string {
  return icsCalendarText({
    name: event.name ?? "Falcons, U8 (Snackday)",
    events: [
      {
        uid: "event_occurrence_1@snackday",
        summary: event.summary,
        startsAt: "2026-03-04T01:00:00.000Z",
        durationMinutes: 60,
        ...(event.location === undefined ? {} : { location: event.location }),
        ...(event.description === undefined ? {} : { description: event.description }),
        cancelled: false,
        updatedAt: "2026-03-01T12:00:00.000Z",
      },
    ],
  });
}

describe("ICS text escaping", () => {
  it("escapes backslash, semicolon, comma, and newlines", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeIcsText("crlf\r\nkept")).toBe("crlf\\nkept");
  });

  it("escapes a LONE carriage return exactly like LF and CRLF", () => {
    // A bare CR ends a content line for every real parser, so all three forms
    // have to collapse to the same escape — see the injection suite below.
    expect(escapeIcsText(`a${CR}b`)).toBe("a\\nb");
    expect(escapeIcsText(`a${CR}b`)).toBe(escapeIcsText("a\r\nb"));
    expect(escapeIcsText(`a${CR}b`)).toBe(escapeIcsText("a\nb"));
  });

  it("drops controls a TEXT value cannot represent, keeping HTAB", () => {
    expect(escapeIcsText(`Field${BEL}${ESC}[31m${DEL}`)).toBe("Field[31m");
    expect(escapeIcsText(`Field${TAB}2`)).toBe(`Field${TAB}2`);
  });

  it("leaves plain text alone", () => {
    expect(escapeIcsText("Practice at Riverside Park")).toBe("Practice at Riverside Park");
  });
});

describe("ICS line folding", () => {
  it("keeps short lines whole", () => {
    expect(foldIcsLine("SUMMARY:Practice")).toBe("SUMMARY:Practice");
  });

  it("folds long lines at 75 octets with a space continuation", () => {
    const folded = foldIcsLine(`DESCRIPTION:${"a".repeat(200)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
    expect(unfold(lines).join("")).toBe(`DESCRIPTION:${"a".repeat(200)}`);
  });

  it("never splits a multi-byte character across a fold", () => {
    const value = "é🥨".repeat(40);
    const folded = foldIcsLine(`SUMMARY:${value}`);
    const lines = folded.split("\r\n");
    for (const line of lines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
      // A split UTF-8 sequence would surface as a replacement character when
      // the folded text is decoded line by line.
      expect(line).not.toContain("�");
    }
    expect(unfold(lines).join("")).toBe(`SUMMARY:${value}`);
  });
});

describe("ICS instants", () => {
  it("renders the RFC 5545 UTC form", () => {
    expect(icsUtcInstant("2026-03-08T01:00:00.000Z")).toBe("20260308T010000Z");
  });

  it("refuses non-timestamps", () => {
    expect(() => icsUtcInstant("not a time")).toThrow();
  });
});

describe("calendar assembly", () => {
  const calendar = {
    name: "Falcons, U8 (Snackday)",
    events: [
      {
        uid: "event_occurrence_1@snackday",
        summary: "Practice; bring water, arrive early",
        startsAt: "2026-03-04T01:00:00.000Z",
        durationMinutes: 60,
        location: "Riverside Park, Field 2",
        description: "Gate code 4411\nPark on the north side",
        cancelled: false,
        updatedAt: "2026-03-01T12:00:00.000Z",
      },
      {
        uid: "event_occurrence_2@snackday",
        summary: "Practice",
        startsAt: "2026-03-11T00:00:00.000Z",
        durationMinutes: 60,
        cancelled: true,
        updatedAt: "2026-03-09T12:00:00.000Z",
      },
    ],
  };

  it("produces a structurally valid VCALENDAR", () => {
    const text = icsCalendarText(calendar);
    const lines = unfold(physicalLines(text));

    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//Snackday//Events//EN");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("X-WR-CALNAME:Falcons\\, U8 (Snackday)");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(2);
  });

  it("emits UTC instants, duration-derived DTEND, and per-event fields", () => {
    const lines = unfold(physicalLines(icsCalendarText(calendar)));

    expect(lines).toContain("UID:event_occurrence_1@snackday");
    expect(lines).toContain("DTSTART:20260304T010000Z");
    expect(lines).toContain("DTEND:20260304T020000Z");
    expect(lines).toContain("SUMMARY:Practice\\; bring water\\, arrive early");
    expect(lines).toContain("LOCATION:Riverside Park\\, Field 2");
    expect(lines).toContain("DESCRIPTION:Gate code 4411\\nPark on the north side");
    expect(lines).toContain("DTSTAMP:20260301T120000Z");
  });

  it("marks a cancelled event CANCELLED with a bumped sequence", () => {
    const lines = unfold(physicalLines(icsCalendarText(calendar)));
    const second = lines.slice(lines.indexOf("UID:event_occurrence_2@snackday"));

    expect(second).toContain("STATUS:CANCELLED");
    expect(second).toContain("SEQUENCE:1");
    expect(lines.slice(0, lines.indexOf("UID:event_occurrence_2@snackday"))).toContain(
      "STATUS:CONFIRMED",
    );
  });

  it("folds every physical line to 75 octets or fewer", () => {
    for (const line of physicalLines(icsCalendarText(calendar))) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

/**
 * `icsCalendarText` output IS the served feed body (calendar-feeds.ts returns
 * it verbatim), and series title/location/notes are manager-typed free text
 * whose validation only trims the edges. So the escaping is an untrusted-input
 * boundary: what a manager types must never become ICS grammar in a
 * subscriber's Apple or Google calendar.
 */
describe("hostile free text cannot reach the ICS grammar", () => {
  it("keeps a CR-laden summary inside one VEVENT with the real UID", () => {
    const lines = lenientLines(
      calendarWithFreeText({
        summary: `Practice${CR}BEGIN:VEVENT${CR}UID:injected@evil${CR}SUMMARY:INJECTED${CR}END:VEVENT`,
      }),
    );

    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("SUMMARY:"))).toHaveLength(1);
    expect(lines).toContain("UID:event_occurrence_1@snackday");
    // A reused UID would overwrite an event already in a victim's calendar.
    expect(lines).not.toContain("UID:injected@evil");
    expect(lines).toContain(
      "SUMMARY:Practice\\nBEGIN:VEVENT\\nUID:injected@evil\\nSUMMARY:INJECTED\\nEND:VEVENT",
    );
  });

  it("refuses a CR-injected VALARM from the notes field", () => {
    const lines = lenientLines(
      calendarWithFreeText({
        summary: "Practice",
        description: `Bring water${CR}BEGIN:VALARM${CR}ACTION:DISPLAY${CR}END:VALARM`,
      }),
    );

    expect(lines).not.toContain("BEGIN:VALARM");
    expect(lines).toContain("DESCRIPTION:Bring water\\nBEGIN:VALARM\\nACTION:DISPLAY\\nEND:VALARM");
  });

  it("lets no forbidden control character reach a content line", () => {
    const text = calendarWithFreeText({
      name: `Falcons${BEL}`,
      summary: `Practice${DEL}`,
      location: `Field${TAB}2${ESC}[31m`,
      description: `Gate${CR}code`,
    });

    // physicalLines already proves CRLF-only breaks; this proves the rest of
    // RFC 5545 §3.1 — HTAB is the one control a content line may carry.
    for (const line of physicalLines(text)) {
      for (const character of line) {
        const code = character.codePointAt(0) ?? 0;
        expect(code === 0x09 || (code >= 0x20 && code !== 0x7f)).toBe(true);
      }
    }
    expect(lenientLines(text)).toContain(`LOCATION:Field${TAB}2[31m`);
  });
});
