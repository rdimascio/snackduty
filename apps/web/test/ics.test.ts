import { describe, expect, it } from "vitest";

import { escapeIcsText, foldIcsLine, icsCalendarText, icsUtcInstant } from "../app/lib/server/ics";

const encoder = new TextEncoder();

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

describe("ICS text escaping", () => {
  it("escapes backslash, semicolon, comma, and newlines", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeIcsText("crlf\r\nkept")).toBe("crlf\\nkept");
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
