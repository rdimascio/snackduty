import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { SqlDatabase } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";

export interface RuntimeDatabase {
  readonly sql: SqlDatabase;
  close(): void | Promise<void>;
}

export async function openRuntimeDatabase(path: string): Promise<RuntimeDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const opened = await openSqlite(path);
  return { sql: opened.db, close: opened.close };
}
