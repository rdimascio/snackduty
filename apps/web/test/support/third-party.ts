import { extname } from "node:path";

import {
  cssDecoders,
  decodeUntilStable,
  markupDecoders,
  removeUrlIgnoredWhitespace,
  scriptDecoders,
} from "./decode-text";
import type { Decoder } from "./decode-text";

export type SourceKind = "css" | "script" | "markup";

export const externalOrigin = /(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+/giu;

export const forbiddenScheme =
  /(?<![a-z\d+.-])(?:https?|wss?|ftp|data|blob|javascript):[^\s"'<>]*/giu;

const cssExtensions: ReadonlySet<string> = new Set([".css"]);

const scriptExtensions: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".json", ".map"]);

export const inlineScriptFinding = "<script> with an inline body";

export const srcdocFinding = "srcdoc attribute";

const inlineScript = /<script\b[^>]*>([^]*?)(?:<\/script|$)/giu;

const srcdocAttribute = /(?<=[\s"'/])srcdoc(?=[\s=/>]|$)/iu;

const tailwindLicenseBanner =
  /\/\*! tailwindcss v\d+\.\d+\.\d+ \| MIT License \| https:\/\/tailwindcss\.com \*\//gu;

const decoderSets: Readonly<Record<SourceKind, readonly (readonly Decoder[])[]>> = {
  css: [cssDecoders],
  script: [cssDecoders, scriptDecoders],
  markup: [markupDecoders, cssDecoders, scriptDecoders],
};

export function sourceKindOf(path: string): SourceKind {
  const extension = extname(path).toLowerCase();
  if (cssExtensions.has(extension)) {
    return "css";
  }
  return scriptExtensions.has(extension) ? "script" : "markup";
}

function normalizedViews(text: string, kind: SourceKind): string[] {
  const withoutBanner = text.replace(tailwindLicenseBanner, "");
  return decoderSets[kind].map((decoders) => decodeUntilStable(withoutBanner, decoders));
}

function hasInlineScriptBody(view: string): boolean {
  for (const match of view.matchAll(inlineScript)) {
    if ((match[1] ?? "").trim() !== "") {
      return true;
    }
  }
  return false;
}

export function findThirdPartyRisks(text: string, kind: SourceKind): string[] {
  const found = new Set<string>();
  for (const view of normalizedViews(text, kind)) {
    if (hasInlineScriptBody(view)) {
      found.add(inlineScriptFinding);
    }
    if (srcdocAttribute.test(view)) {
      found.add(srcdocFinding);
    }
    const urlView = removeUrlIgnoredWhitespace(view).replaceAll("\\", "/");
    for (const pattern of [externalOrigin, forbiddenScheme]) {
      for (const match of urlView.matchAll(pattern)) {
        found.add(match[0]);
      }
    }
  }
  return [...found];
}

const inlineStyleAttribute = /<[^>]*?[\s"'/]style\s*=/iu;

const styleElement = /<style\b/iu;

export function hasInlineScript(markup: string): boolean {
  return normalizedViews(markup, "markup").some((view) => hasInlineScriptBody(view));
}

export function hasInlineStyle(markup: string): boolean {
  return inlineStyleAttribute.test(markup) || styleElement.test(markup);
}
