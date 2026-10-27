import { readdirSync, readFileSync } from "node:fs";

import { staticCacheControl } from "@lesto/runtime";
import type { AnyLestoResponse } from "@lesto/web";

const FONT_DIRECTORY = new URL("../../public/fonts/", import.meta.url);

const FONT_EXTENSION = ".woff2";

export const FONT_ROUTE = "/fonts/:file";

function loadPublicFonts(): ReadonlyMap<string, Uint8Array> {
  const fonts = new Map<string, Uint8Array>();
  for (const file of readdirSync(FONT_DIRECTORY)) {
    if (file.endsWith(FONT_EXTENSION)) {
      fonts.set(file, new Uint8Array(readFileSync(new URL(file, FONT_DIRECTORY))));
    }
  }
  return fonts;
}

const publicFonts = loadPublicFonts();

export function fontResponse(file: string): AnyLestoResponse {
  const font = publicFonts.get(file);
  if (font === undefined) {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "Not Found" };
  }
  return {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "cache-control": staticCacheControl(file),
      "x-content-type-options": "nosniff",
    },
    body: font,
  };
}
