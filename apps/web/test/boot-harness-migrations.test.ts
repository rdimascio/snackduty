import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applicationMigrations } from "../app/lib/server/composition";

const BOOT_HARNESS = fileURLToPath(new URL("../../../infra/ami/ci-boot.py", import.meta.url));

describe("Linux boot harness", () => {
  it("expects exactly as many first-boot migrations as the app ships", async () => {
    const harness = await readFile(BOOT_HARNESS, "utf8");
    const declared = /^EXPECTED_MIGRATIONS = (\d+)$/mu.exec(harness)?.[1];

    expect(Number(declared)).toBe(applicationMigrations.length);
  });
});
