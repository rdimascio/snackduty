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

const targets = process.argv.slice(2);
await rm(ARTIFACTS_DIR, { recursive: true, force: true });

const built = await run(["bun", "--bun", "lesto", "build"], WEB_ROOT);
if (built !== 0) {
  console.error(`lesto build exited with code ${built}`);
  process.exit(built);
}

const tested = await run(
  [
    "bun",
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
