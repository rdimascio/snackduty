export type MarkdownInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "emphasis"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly MarkdownInline[] };

export type MarkdownBlock =
  | {
      readonly kind: "heading";
      readonly level: 2 | 3;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly kind: "paragraph"; readonly children: readonly MarkdownInline[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly MarkdownInline[])[];
    };

const INLINE_TOKEN = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/u;

const SAME_ORIGIN_PATH = /^\/(?!\/)[^\s\\]*$/u;

const HEADING = /^(#{1,6}) (.+)$/u;

const UNORDERED_ITEM = /^- (.+)$/u;

const ORDERED_ITEM = /^\d+\. (.+)$/u;

const ALLOWED_HEADING_LEVELS: ReadonlySet<number> = new Set([2, 3]);

export class MarkdownError extends Error {}

function assertSameOriginPath(href: string): string {
  if (!SAME_ORIGIN_PATH.test(href)) {
    throw new MarkdownError(`Article links must be same-origin paths, not ${href}.`);
  }
  return href;
}

export function parseInline(text: string): readonly MarkdownInline[] {
  const match = INLINE_TOKEN.exec(text);
  if (match === null) return text === "" ? [] : [{ kind: "text", text }];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const [, strong, emphasis, linkText, href] = match;
  let token: MarkdownInline;
  if (strong !== undefined) token = { kind: "strong", children: parseInline(strong) };
  else if (emphasis !== undefined) token = { kind: "emphasis", children: parseInline(emphasis) };
  else
    token = {
      kind: "link",
      href: assertSameOriginPath(href ?? ""),
      children: parseInline(linkText ?? ""),
    };
  return [
    ...(before === "" ? [] : [{ kind: "text", text: before } as const]),
    token,
    ...parseInline(after),
  ];
}

function headingOf(line: string): MarkdownBlock | undefined {
  const match = HEADING.exec(line);
  if (match === null) return undefined;
  const level = (match[1] ?? "").length;
  if (!ALLOWED_HEADING_LEVELS.has(level)) {
    throw new MarkdownError(`Article headings must be level 2 or 3, not level ${level}.`);
  }
  return { kind: "heading", level: level === 2 ? 2 : 3, children: parseInline(match[2] ?? "") };
}

function listOf(lines: readonly string[]): MarkdownBlock | undefined {
  for (const [pattern, ordered] of [
    [UNORDERED_ITEM, false],
    [ORDERED_ITEM, true],
  ] as const) {
    const items = lines.map((line) => pattern.exec(line)?.[1]);
    if (items.every((item) => item !== undefined)) {
      return { kind: "list", ordered, items: items.map((item) => parseInline(item)) };
    }
  }
  return undefined;
}

function blockOf(lines: readonly string[]): readonly MarkdownBlock[] {
  const [first] = lines;
  if (first === undefined) return [];
  const heading = headingOf(first);
  if (heading !== undefined) return [heading, ...blockOf(lines.slice(1))];
  const list = listOf(lines);
  if (list !== undefined) return [list];
  return [{ kind: "paragraph", children: parseInline(lines.join(" ")) }];
}

/** Parses the small Markdown subset the coach articles use: headings, paragraphs, lists, bold, italics and same-origin links. */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  return source
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/u)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    )
    .flatMap((lines) => blockOf(lines));
}
