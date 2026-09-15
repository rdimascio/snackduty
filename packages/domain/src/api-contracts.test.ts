import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  adultIdentitySchema,
  appleChallengeSchema,
  apiErrorSchema,
  rosterResponseSchema,
  signedOutSchema,
  teamDirectorySchema,
} from "./api-contracts";

describe("canonical native/API fixtures", () => {
  for (const [name, schema] of [
    ["adult-identity", adultIdentitySchema],
    ["apple-challenge", appleChallengeSchema],
    ["session-signed-out", signedOutSchema],
    ["error-unauthorized", apiErrorSchema],
    ["empty-directory", teamDirectorySchema],
    ["team-directory", teamDirectorySchema],
    ["roster-privacy", rosterResponseSchema],
  ] as const) {
    it(`validates ${name}`, () => {
      const data: unknown = JSON.parse(
        readFileSync(new URL(`../../../contracts/fixtures/${name}.json`, import.meta.url), "utf8"),
      );
      expect(schema.safeParse(data).success).toBe(true);
    });
  }
});
