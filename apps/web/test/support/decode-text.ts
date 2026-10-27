const characterReference =
  /&#x([\da-f]+);?|&#(\d+);?|&(amp|colon|sol|bsol|percnt|tab|newline|lt|gt|quot|apos);?/giu;

const namedReferences: Readonly<Record<string, string>> = {
  amp: "&",
  colon: ":",
  sol: "/",
  bsol: "\\",
  percnt: "%",
  tab: "\t",
  newline: "\n",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const percentEncoding = /%([\da-f]{2})/giu;

const cssAndUnicodeEscape =
  /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\da-f]{1,6})\s?|([^]))/giu;

const jsEscape =
  /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|([^]))/giu;

const controlEscapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

const urlIgnoredWhitespace = /[\t\n\r]/gu;

const replacementCharacter = "�";

const highestAsciiCode = 0x7f;

export type Decoder = (text: string) => string;

function fromCode(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10_ff_ff
    ? String.fromCodePoint(code)
    : replacementCharacter;
}

function decodeCharacterReferences(text: string): string {
  return text.replace(
    characterReference,
    (_reference: string, hex?: string, decimal?: string, name?: string): string => {
      if (hex !== undefined) {
        return fromCode(Number.parseInt(hex, 16));
      }
      if (decimal !== undefined) {
        return fromCode(Number(decimal));
      }
      return namedReferences[(name ?? "").toLowerCase()] ?? replacementCharacter;
    },
  );
}

function decodePercentEncoding(text: string): string {
  return text.replace(percentEncoding, (encoded: string, hex: string): string => {
    const code = Number.parseInt(hex, 16);
    return code <= highestAsciiCode ? String.fromCodePoint(code) : encoded;
  });
}

function decodeCssAndUnicodeEscapes(text: string): string {
  return text.replace(
    cssAndUnicodeEscape,
    (
      _escape: string,
      braced?: string,
      unicode?: string,
      byte?: string,
      cssHex?: string,
      literal?: string,
    ): string => {
      const hex = braced ?? unicode ?? byte ?? cssHex;
      if (hex !== undefined) {
        return fromCode(Number.parseInt(hex, 16));
      }
      const character = literal ?? "";
      return controlEscapes[character] ?? character;
    },
  );
}

function decodeJsEscapes(text: string): string {
  return text.replace(
    jsEscape,
    (
      _escape: string,
      braced?: string,
      unicode?: string,
      byte?: string,
      octal?: string,
      literal?: string,
    ): string => {
      const hex = braced ?? unicode ?? byte;
      if (hex !== undefined) {
        return fromCode(Number.parseInt(hex, 16));
      }
      if (octal !== undefined) {
        return fromCode(Number.parseInt(octal, 8));
      }
      const character = literal ?? "";
      return controlEscapes[character] ?? character;
    },
  );
}

export function removeUrlIgnoredWhitespace(text: string): string {
  return text.replace(urlIgnoredWhitespace, "");
}

export function decodeUntilStable(text: string, decoders: readonly Decoder[]): string {
  let previous = text;
  let current = text;
  do {
    previous = current;
    current = decoders.reduce((value, decode) => decode(value), previous);
  } while (current !== previous);
  return current;
}

export const markupDecoders: readonly Decoder[] = [
  decodeCharacterReferences,
  decodePercentEncoding,
];

export const cssDecoders: readonly Decoder[] = [...markupDecoders, decodeCssAndUnicodeEscapes];

export const scriptDecoders: readonly Decoder[] = [...markupDecoders, decodeJsEscapes];
