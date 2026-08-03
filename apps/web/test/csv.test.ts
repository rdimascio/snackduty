import { describe, expect, it } from "vitest";

import { CSV_LIMITS, isBlankRecord, parseCsv } from "../app/lib/server/csv";
import type { CsvParseResult } from "../app/lib/server/csv";

// U+FEFF as a code point, so this test file carries no non-printable byte.
const BOM = String.fromCodePoint(0xfe_ff);

function fieldsOf(result: CsvParseResult): string[][] {
  if (!result.ok) throw new Error(`expected a parse, got ${result.error.code}`);
  return result.records.map((record) => [...record.fields]);
}

function linesOf(result: CsvParseResult): number[] {
  if (!result.ok) throw new Error(`expected a parse, got ${result.error.code}`);
  return result.records.map((record) => record.line);
}

function errorOf(result: CsvParseResult) {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("csv parsing", () => {
  it("reads plain rows, preserving field order and empty cells", () => {
    const parsed = parseCsv("a,b,c\n1,,3");

    expect(fieldsOf(parsed)).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
    expect(linesOf(parsed)).toEqual([1, 2]);
  });

  it("keeps commas, quotes, and newlines that live inside quoted fields", () => {
    const parsed = parseCsv('name,note\n"Rivera, Sam","said ""hi"" twice"\n"two\nlines",tail');

    expect(fieldsOf(parsed)).toEqual([
      ["name", "note"],
      ["Rivera, Sam", 'said "hi" twice'],
      ["two\nlines", "tail"],
    ]);
    // The embedded newline moves the LINE counter, so the record after it
    // reports the line a human would count in their editor.
    expect(linesOf(parsed)).toEqual([1, 2, 3]);
  });

  it("treats a doubled quote as the only escape, including at a field's edges", () => {
    expect(fieldsOf(parseCsv('"""",""""""'))).toEqual([['"', '""']]);
    expect(fieldsOf(parseCsv('"",x'))).toEqual([["", "x"]]);
  });

  it("accepts CRLF, LF, and a lone CR as record separators", () => {
    expect(fieldsOf(parseCsv("a,b\r\nc,d\r\n"))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(fieldsOf(parseCsv("a\rb\rc"))).toEqual([["a"], ["b"], ["c"]]);
    expect(linesOf(parseCsv("a\rb\rc"))).toEqual([1, 2, 3]);
  });

  it("normalizes CRLF and lone CR to LF inside a quoted field", () => {
    expect(fieldsOf(parseCsv('"one\r\ntwo\rthree"'))).toEqual([["one\ntwo\nthree"]]);
    expect(linesOf(parseCsv('"one\r\ntwo"\nx'))).toEqual([1, 3]);
  });

  it("strips a leading UTF-8 BOM from the first header cell only", () => {
    const parsed = parseCsv(`${BOM}child_name,birth_date\nCasey,2018-04-09`);

    expect(fieldsOf(parsed)[0]).toEqual(["child_name", "birth_date"]);
  });

  it("does not invent a record for a trailing newline", () => {
    for (const trailing of ["", "\n", "\r\n", "\r"]) {
      expect(fieldsOf(parseCsv(`a,b\nc,d${trailing}`))).toHaveLength(2);
    }
  });

  it("returns no records for empty input and one empty record for a blank line", () => {
    expect(fieldsOf(parseCsv(""))).toEqual([]);
    expect(fieldsOf(parseCsv("a\n\nb"))).toEqual([["a"], [""], ["b"]]);
    const blank = parseCsv("a\n\nb");
    if (!blank.ok) throw new Error("expected a parse");
    expect(blank.records.map(isBlankRecord)).toEqual([false, true, false]);
    expect(isBlankRecord({ line: 1, fields: ["  ", ""] })).toBe(true);
  });

  it("keeps surrounding whitespace and a quote inside an unquoted field verbatim", () => {
    expect(fieldsOf(parseCsv(' a , b\nSam "Slugger" Rivera,x'))).toEqual([
      [" a ", " b"],
      ['Sam "Slugger" Rivera', "x"],
    ]);
  });

  it("keeps text that follows a closing quote instead of refusing the file", () => {
    expect(fieldsOf(parseCsv('"Sam" Rivera,next'))).toEqual([["Sam Rivera", "next"]]);
  });

  it("refuses an unterminated quote, naming the line and field position only", () => {
    const error = errorOf(parseCsv('ok,fine\nCasey Kid,"Alex Guardian'));

    expect(error.code).toBe("csv_unterminated_quote");
    expect(error.line).toBe(2);
    expect(error.field).toBe(2);
    // PRIVACY: not one character of the file's content is echoed.
    expect(error.message).not.toContain("Casey");
    expect(error.message).not.toContain("Alex");
  });

  it("refuses input past the character bound before doing any work", () => {
    const error = errorOf(parseCsv("a".repeat(CSV_LIMITS.maxCharacters + 1)));

    expect(error.code).toBe("csv_too_large");
    expect(error.line).toBeUndefined();
  });

  it("refuses too many records, too many fields, and an over-long value", () => {
    const tiny = {
      maxCharacters: 10_000,
      maxRecords: 2,
      maxFieldsPerRecord: 3,
      maxFieldCharacters: 5,
    };

    expect(errorOf(parseCsv("a\nb\nc", tiny)).code).toBe("csv_too_many_records");

    const wide = errorOf(parseCsv("a,b,c,d", tiny));
    expect(wide.code).toBe("csv_too_many_fields");
    expect(wide.line).toBe(1);

    const long = errorOf(parseCsv("ok\nabcdefgh", tiny));
    expect(long.code).toBe("csv_field_too_long");
    expect(long.line).toBe(2);
    expect(long.field).toBe(1);
    expect(long.message).not.toContain("abcdefgh");
  });

  it("counts a quoted field's characters after unescaping, not as written", () => {
    const tiny = {
      maxCharacters: 100,
      maxRecords: 5,
      maxFieldsPerRecord: 5,
      maxFieldCharacters: 3,
    };

    // Eight source characters — one opening quote, three `""` escapes, one
    // closing quote — are three parsed ones, which is what the bound sees.
    expect(fieldsOf(parseCsv('""""""""', tiny))).toEqual([['"""']]);
  });

  it("reads a realistic roster export end to end", () => {
    const csv = `${BOM}child_name,birth_date,guardian1_name,guardian1_relationship\r\n"Kid, Casey",2018-04-09,Alex Guardian,parent\r\nRowan Child,,"Sam ""Sammy"" Rivera",caregiver\r\n`;

    expect(fieldsOf(parseCsv(csv))).toEqual([
      ["child_name", "birth_date", "guardian1_name", "guardian1_relationship"],
      ["Kid, Casey", "2018-04-09", "Alex Guardian", "parent"],
      ["Rowan Child", "", 'Sam "Sammy" Rivera', "caregiver"],
    ]);
  });
});
