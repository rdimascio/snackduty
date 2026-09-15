import { copyFile, lstat, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { SqlDatabase } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";

export class RuntimeBackupError extends Error {
  readonly code = "RUNTIME_BACKUP_INVALID";
}

export interface RuntimeBackupReceipt {
  readonly sourcePath: string;
  readonly backupPath: string;
  readonly sourceBytes: number;
  readonly backupBytes: number;
  readonly integrity: "ok";
}

export interface RuntimeRestoreReceipt {
  readonly backupPath: string;
  readonly restoredPath: string;
  readonly restoredBytes: number;
  readonly integrity: "ok";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function absoluteDistinctPaths(sourcePath: string, targetPath: string): [string, string] {
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath)) {
    throw new RuntimeBackupError("Backup and restore paths must be absolute.");
  }

  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (source === target) throw new RuntimeBackupError("Source and destination must differ.");
  return [source, target];
}

async function requireAbsent(path: string): Promise<void> {
  if (await exists(path)) {
    throw new RuntimeBackupError(`Refusing to overwrite existing path: ${path}`);
  }
}

async function requireDatabaseFile(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RuntimeBackupError(`Database file does not exist: ${path}`);
    }
    throw error;
  }
  if (!info.isFile() || info.size === 0) {
    throw new RuntimeBackupError(`Database path is not a non-empty file: ${path}`);
  }
}

export async function verifySqliteIntegrity(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new RuntimeBackupError("Database path must be absolute.");
  const databasePath = resolve(path);
  await requireDatabaseFile(databasePath);
  const opened = await openSqlite(databasePath);
  try {
    const result = await opened.db.prepare("PRAGMA integrity_check").get();
    const values = result !== null && typeof result === "object" ? Object.values(result) : [];
    if (!values.includes("ok")) throw new RuntimeBackupError("SQLite integrity check failed.");

    const foreignKeyFailures = await opened.db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new RuntimeBackupError("SQLite foreign-key check failed.");
    }
  } finally {
    opened.close();
  }
}

export async function createSqliteBackup(
  sql: SqlDatabase,
  sourcePath: string,
  backupPath: string,
): Promise<RuntimeBackupReceipt> {
  const [source, backup] = absoluteDistinctPaths(sourcePath, backupPath);
  const partial = `${backup}.partial`;
  await requireDatabaseFile(source);
  await requireAbsent(backup);
  await requireAbsent(partial);
  await mkdir(dirname(backup), { recursive: true });

  try {
    await sql.prepare("VACUUM INTO ?").run([partial]);
    await verifySqliteIntegrity(partial);
    await rename(partial, backup);
  } catch (error) {
    await unlink(partial).catch(() => null);
    throw error;
  }

  const [sourceInfo, backupInfo] = await Promise.all([stat(source), stat(backup)]);
  return {
    sourcePath: source,
    backupPath: backup,
    sourceBytes: sourceInfo.size,
    backupBytes: backupInfo.size,
    integrity: "ok",
  };
}

export async function backupSqliteFile(
  sourcePath: string,
  backupPath: string,
): Promise<RuntimeBackupReceipt> {
  if (!isAbsolute(sourcePath)) throw new RuntimeBackupError("Database path must be absolute.");
  const source = resolve(sourcePath);
  await requireDatabaseFile(source);
  const opened = await openSqlite(source);
  try {
    return await createSqliteBackup(opened.db, source, backupPath);
  } finally {
    opened.close();
  }
}

export async function restoreSqliteBackup(
  backupPath: string,
  restoredPath: string,
): Promise<RuntimeRestoreReceipt> {
  const [backup, restored] = absoluteDistinctPaths(backupPath, restoredPath);
  const partial = `${restored}.partial`;
  await requireAbsent(restored);
  await requireAbsent(partial);
  await verifySqliteIntegrity(backup);
  await mkdir(dirname(restored), { recursive: true });

  try {
    await copyFile(backup, partial);
    await verifySqliteIntegrity(partial);
    await rename(partial, restored);
  } catch (error) {
    await unlink(partial).catch(() => null);
    throw error;
  }

  return {
    backupPath: backup,
    restoredPath: restored,
    restoredBytes: (await stat(restored)).size,
    integrity: "ok",
  };
}
