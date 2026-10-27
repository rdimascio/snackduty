import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accounts, people, VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
import { openRuntimeApplication } from "../runtime";

const webRoot = join(import.meta.dirname, "..");
const seedPath = "/api/dev/teams/team_probe/participants/participant_probe/skill-events";
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function probeLestoEntry(devSignIn: "true" | "false"): { seed: number; signIn: number } {
  const result = spawnSync(process.execPath, [join(webRoot, "test/support/dev-route-probe.ts")], {
    cwd: webRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      LESTO_DB: ":memory:",
      SNACKDAY_RUNTIME_MODE: "development",
      SNACKDAY_DEV_SIGN_IN: devSignIn,
      SNACKDAY_LESSON_OF_THE_WEEK: "true",
    },
  });
  expect(result.status).toBe(0);
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(lastLine) as { seed: number; signIn: number };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("development skill event seed route registration", () => {
  it("is registered by the Lesto entry only when development sign-in is on", () => {
    expect(probeLestoEntry("true")).toEqual({ seed: 401, signIn: 200 });
    expect(probeLestoEntry("false")).toEqual({ seed: 404, signIn: 404 });
  }, 30_000);

  it("is never imported by the production Worker or runtime entry", async () => {
    const files = [join(webRoot, "worker.ts"), ...(await sourceFiles(join(webRoot, "runtime")))];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(await readFile(file, "utf8")).not.toMatch(/app\/dev\b|registerDevSkillEventRoutes/u);
    }
  });

  it("answers 404 from the production runtime to an authenticated adult", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snackday-dev-route-"));
    scratchDirectories.push(directory);
    const runtime = await openRuntimeApplication({
      mode: "staging",
      databasePath: join(directory, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL("https://staging.snackduty.test"),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    });
    try {
      const stamp = "2026-10-26T12:00:00.000Z";
      await runtime.db
        .insert(people)
        .values({
          id: "person_seed_probe",
          displayName: "Seed Probe Adult",
          status: "active",
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      await runtime.db
        .insert(accounts)
        .values({
          id: "account_seed_probe",
          personId: "person_seed_probe",
          status: "active",
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      const session = await runtime.sessions.create("account_seed_probe", 60_000);
      const response = await runtime.app.handle("POST", seedPath, {
        headers: {
          "sec-fetch-site": "same-origin",
          cookie: `${VERIFIED_SESSION_COOKIE}=${session.token}`,
        },
        body: [],
      });
      expect(response.status).toBe(404);
    } finally {
      await runtime.close();
    }
  });
});
