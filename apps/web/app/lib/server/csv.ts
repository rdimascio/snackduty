/**
 * A dependency-free CSV reader — RFC 4180 with the concessions real spreadsheet
 * exports demand, and hard bounds so a hostile or accidental upload cannot melt
 * the server.
 *
 * WHY HAND-WRITTEN: this parser is the only thing standing between a manager's
 * spreadsheet and a child's record, so its exact behavior — and its refusal
 * behavior — is part of the product, not a transitive dependency's choice. It
 * is small and fully covered by `test/csv.test.ts`.
 *
 * What it handles:
 *   - quoted fields, with embedded commas, embedded newlines, and `""` escapes
 *   - `\r\n`, `\n`, and a lone `\r` as record separators (old Mac exports),
 *     with any newline INSIDE a quoted field normalized to `\n`
 *   - a leading UTF-8 BOM (Excel writes one)
 *   - a trailing newline, which does NOT produce a phantom empty record
 *   - text after a closing quote (`"a"b`), kept LITERALLY rather than refused:
 *     a stray quote in a name must not cost a manager their whole upload
 *   - bounds on total size, record count, field count, and field length, each
 *     refused with a coded error naming a POSITION
 *
 * What it deliberately does NOT do: interpret the data. It returns raw strings
 * and the 1-based source LINE each record started on; meaning (which column is
 * a child, what a duplicate is) belongs to `roster-import.ts`.
 *
 * PRIVACY: every error names a line and/or a field POSITION and never carries
 * a character of the file's content — a CSV cell may hold a child's name, and
 * an error is the one payload that reaches logs.
 */

/** One parsed record: its fields, and the 1-based line its first field began on. */
export interface CsvRecord {
  readonly line: number;
  readonly fields: readonly string[];
}

export interface CsvLimits {
  /** Total characters accepted, BOM excluded. UTF-8 bytes are always >= this. */
  readonly maxCharacters: number;
  readonly maxRecords: number;
  readonly maxFieldsPerRecord: number;
  readonly maxFieldCharacters: number;
}

/**
 * Roster-sized bounds. The runtime already caps a request body at 1 MiB; these
 * are tighter on purpose — a team roster is tens of rows, so anything past this
 * is a mistake or an attack, and both deserve the same clear refusal.
 */
export const CSV_LIMITS: CsvLimits = {
  maxCharacters: 262_144,
  maxRecords: 501,
  maxFieldsPerRecord: 32,
  maxFieldCharacters: 512,
};

export type CsvErrorCode =
  | "csv_too_large"
  | "csv_too_many_records"
  | "csv_too_many_fields"
  | "csv_field_too_long"
  | "csv_unterminated_quote";

/** A refusal: a code, a position, and a message that quotes NO file content. */
export interface CsvError {
  readonly code: CsvErrorCode;
  readonly message: string;
  /** 1-based source line of the offending record, when the code has one. */
  readonly line?: number;
  /** 1-based field position within that record, when the code has one. */
  readonly field?: number;
}

export type CsvParseResult =
  | { readonly ok: true; readonly records: readonly CsvRecord[] }
  | { readonly ok: false; readonly error: CsvError };

// U+FEFF, written as a code point so this source file holds no non-printable byte.
const BOM_CODE_POINT = 0xfe_ff;
const QUOTE = '"';
const DELIMITER = ",";
const LF = "\n";
const CR = "\r";

function refuse(error: CsvError): CsvParseResult {
  return { ok: false, error };
}

function isRecordEnd(character: string | undefined): boolean {
  return character === undefined || character === LF || character === CR;
}

/**
 * Parse `input` into records, or refuse with a positional error.
 *
 * The scanner is a single pass with two states (inside a quoted field or not),
 * which is what makes the nasty cases — a comma inside quotes, a newline inside
 * quotes, `""` — fall out rather than needing special-casing.
 */
export function parseCsv(input: string, limits: CsvLimits = CSV_LIMITS): CsvParseResult {
  const text = input.charCodeAt(0) === BOM_CODE_POINT ? input.slice(1) : input;
  if (text.length > limits.maxCharacters) {
    return refuse({
      code: "csv_too_large",
      message: `The file is larger than the ${limits.maxCharacters}-character import limit.`,
    });
  }

  const records: CsvRecord[] = [];
  let index = 0;
  let line = 1;

  while (index < text.length) {
    const startLine = line;
    const fields: string[] = [];

    for (;;) {
      let value = "";

      if (text[index] === QUOTE) {
        index += 1;
        let closed = false;
        while (index < text.length) {
          const character = text[index];
          if (character === QUOTE) {
            if (text[index + 1] === QUOTE) {
              value += QUOTE;
              index += 2;
              continue;
            }
            index += 1;
            closed = true;
            break;
          }
          if (character === CR) {
            // A newline inside quotes is DATA. Normalize CRLF and a lone CR to
            // `\n` so a downstream value never depends on the file's origin.
            if (text[index + 1] === LF) index += 1;
            value += LF;
            index += 1;
            line += 1;
            continue;
          }
          if (character === LF) line += 1;
          value += character ?? "";
          index += 1;
        }
        if (!closed) {
          return refuse({
            code: "csv_unterminated_quote",
            message: "A quoted value is never closed; add the missing double quote.",
            line: startLine,
            field: fields.length + 1,
          });
        }
        // Lenient tail: `"Sam" Rivera` keeps ` Rivera` instead of refusing the
        // whole upload over one stray quote.
        while (index < text.length && text[index] !== DELIMITER && !isRecordEnd(text[index])) {
          value += text[index] ?? "";
          index += 1;
        }
      } else {
        while (index < text.length && text[index] !== DELIMITER && !isRecordEnd(text[index])) {
          value += text[index] ?? "";
          index += 1;
        }
      }

      if (value.length > limits.maxFieldCharacters) {
        return refuse({
          code: "csv_field_too_long",
          message: `A value is longer than the ${limits.maxFieldCharacters}-character limit.`,
          line: startLine,
          field: fields.length + 1,
        });
      }
      fields.push(value);
      if (fields.length > limits.maxFieldsPerRecord) {
        return refuse({
          code: "csv_too_many_fields",
          message: `A row has more than the ${limits.maxFieldsPerRecord} columns this import accepts.`,
          line: startLine,
        });
      }

      const next = text[index];
      if (next === DELIMITER) {
        index += 1;
        continue;
      }
      if (next === CR) {
        index += text[index + 1] === LF ? 2 : 1;
        line += 1;
      } else if (next === LF) {
        index += 1;
        line += 1;
      }
      break;
    }

    records.push({ line: startLine, fields });
    if (records.length > limits.maxRecords) {
      return refuse({
        code: "csv_too_many_records",
        message: `The file has more than the ${limits.maxRecords} rows this import accepts.`,
      });
    }
  }

  return { ok: true, records };
}

/** Whether a record is entirely empty — a blank line the reader should skip. */
export function isBlankRecord(record: CsvRecord): boolean {
  return record.fields.every((field) => field.trim() === "");
}
