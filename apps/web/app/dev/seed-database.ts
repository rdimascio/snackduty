import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installSessionSchema } from "@lesto/auth";
import type { SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";

import { applicationMigrations } from "../lib/server/composition";

export const SEED_DIRECTORY = fileURLToPath(new URL("../../../../seed/", import.meta.url));

const SEED_FILE_NAME = /^\d{3}_[a-z0-9_]+\.sql$/u;

export async function seedFiles(directory: string = SEED_DIRECTORY): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => SEED_FILE_NAME.test(name));
  return names.toSorted().map((name) => join(directory, name));
}

export async function migrateDatabase(sql: SqlDatabase): Promise<void> {
  await installSessionSchema(sql);
  await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
}

export async function applySeed(
  sql: SqlDatabase,
  directory: string = SEED_DIRECTORY,
): Promise<string[]> {
  const files = await seedFiles(directory);
  if (files.length === 0) throw new Error(`no seed files in ${directory}`);
  await sql.transaction(async (tx) => {
    for (const file of files) {
      const statements = await readFile(file, "utf8");
      try {
        await tx.exec(statements);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`seed/${basename(file)}: ${reason}`, { cause: error });
      }
    }
  });
  return files.map((file) => basename(file));
}

export async function seedDatabase(
  databasePath: string,
  options: { readonly migrate?: boolean; readonly directory?: string } = {},
): Promise<string[]> {
  const { db, close } = await openSqlite(databasePath);
  try {
    if (options.migrate !== false) await migrateDatabase(db);
    return await applySeed(db, options.directory);
  } finally {
    close();
  }
}
