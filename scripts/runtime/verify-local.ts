import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  createSqliteBackup,
  openRuntimeApplication,
  restoreSqliteBackup,
} from "../../apps/web/runtime";
import type { RuntimeConfiguration } from "../../apps/web/runtime";

function configuration(databasePath: string): RuntimeConfiguration {
  return {
    mode: "staging",
    databasePath,
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL("https://local-runtime-verification.invalid"),
    appleClientId: "com.snackday.local-runtime-verification",
    upstreamCredentialPathLoggingSafe: false,
  };
}

async function main(argument: string | undefined): Promise<void> {
  if (argument === undefined || !isAbsolute(argument)) {
    throw new Error("Usage: bun scripts/runtime/verify-local.ts <new-absolute-work-directory>");
  }

  const directory = resolve(argument);
  await mkdir(directory);
  const databasePath = join(directory, "live", "snackduty.db");
  const backupPath = join(directory, "backup", "snackduty.db");
  const restoredPath = join(directory, "restored", "snackduty.db");
  const sessionTtlMs = 60_000;

  try {
    const first = await openRuntimeApplication(configuration(databasePath));
    const migrationVersions = first.migrationsApplied;
    const session = await first.sessions.create("runtime-verification-account", sessionTtlMs);
    await first.close();

    const restarted = await openRuntimeApplication(configuration(databasePath));
    const sessionAfterRestart = await restarted.sessions.verify(session.token);
    const backup = await createSqliteBackup(restarted.sql, databasePath, backupPath);
    await restarted.close();

    const restore = await restoreSqliteBackup(backupPath, restoredPath);
    const restored = await openRuntimeApplication(configuration(restoredPath));
    const sessionAfterRestore = await restored.sessions.verify(session.token);
    await restored.close();

    const verified =
      migrationVersions.length > 0 &&
      sessionAfterRestart?.userId === "runtime-verification-account" &&
      sessionAfterRestore?.userId === "runtime-verification-account";
    console.log(
      JSON.stringify(
        {
          verified,
          migrationVersions,
          restartAppliedMigrations: restarted.migrationsApplied,
          sessionPersistedAcrossRestart: sessionAfterRestart !== undefined,
          backup,
          restore,
          sessionPersistedAcrossRestore: sessionAfterRestore !== undefined,
          stagingVerified: false,
        },
        null,
        2,
      ),
    );
    if (!verified) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv[2]);
