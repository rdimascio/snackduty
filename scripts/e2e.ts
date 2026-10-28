#!/usr/bin/env bun

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_ROOT = join(ROOT, "apps", "web");
const ARTIFACTS_DIR = join(ROOT, ".artifacts", "e2e");
const TEST_TIMEOUT_MS = 180_000;

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<number> {
  const child = Bun.spawn({
    cmd,
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

const MINIMUM_BUN = [1, 4, 2] as const;

function bunIsAtLeast(minimum: readonly number[]): boolean {
  const current = Bun.version.split(".").map(Number);
  for (const [index, wanted] of minimum.entries()) {
    const have = current[index] ?? 0;
    if (have !== wanted) return have > wanted;
  }
  return true;
}

if (!bunIsAtLeast(MINIMUM_BUN)) {
  console.error(
    `bun run e2e needs Bun ${MINIMUM_BUN.join(".")} or later; Bun ${Bun.version} drops Playwright's browser connection mid-run. Run it with bunx bun@${MINIMUM_BUN.join(".")} scripts/e2e.ts`,
  );
  process.exit(1);
}

const targets = process.argv.slice(2);
await rm(ARTIFACTS_DIR, { recursive: true, force: true });

const built = await run([process.execPath, "--bun", "lesto", "build"], WEB_ROOT);
if (built !== 0) {
  console.error(`lesto build exited with code ${built}`);
  process.exit(built);
}

const tested = await run(
  [
    process.execPath,
    "test",
    "--timeout",
    String(TEST_TIMEOUT_MS),
    ...(targets.length === 0 ? ["./e2e/"] : targets),
  ],
  ROOT,
  { E2E_ARTIFACTS_DIR: ARTIFACTS_DIR },
);
if (tested !== 0) console.error(`e2e failed; traces and screenshots are in ${ARTIFACTS_DIR}`);
process.exit(tested);
