import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { SqlDatabase } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";

export interface SqliteRuntimeDatabaseTarget {
  readonly dialect: "sqlite";
  readonly path: string;
}

export interface PostgresRuntimeDatabaseTarget {
  readonly dialect: "postgres";
  readonly connectionString: string;
  readonly maxConnections: number;
}

export type RuntimeDatabaseTarget = SqliteRuntimeDatabaseTarget | PostgresRuntimeDatabaseTarget;

export interface RuntimeDatabase {
  readonly dialect: "sqlite" | "postgres";
  readonly sql: SqlDatabase;
  close(): void | Promise<void>;
}

export interface PostgresConnectionConfiguration {
  readonly connectionString: string;
  readonly max: number;
}

export interface RuntimeDatabaseDrivers {
  /**
   * Kept explicit until the application owns direct `@lesto/pg` and `pg`
   * dependencies. A Postgres target without this driver must refuse to boot.
   */
  readonly openPostgres?: (
    configuration: PostgresConnectionConfiguration,
  ) => Promise<{ readonly db: SqlDatabase; close(): void | Promise<void> }>;
}

export class RuntimeDatabaseDriverUnavailableError extends Error {
  readonly code = "RUNTIME_DATABASE_DRIVER_UNAVAILABLE";
}

export async function openRuntimeDatabase(
  target: RuntimeDatabaseTarget,
  drivers: RuntimeDatabaseDrivers = {},
): Promise<RuntimeDatabase> {
  if (target.dialect === "postgres") {
    if (drivers.openPostgres === undefined) {
      throw new RuntimeDatabaseDriverUnavailableError(
        "The PostgreSQL runtime driver has not been wired into this application artifact.",
      );
    }

    const opened = await drivers.openPostgres({
      connectionString: target.connectionString,
      max: target.maxConnections,
    });
    return { dialect: target.dialect, sql: opened.db, close: opened.close };
  }

  await mkdir(dirname(target.path), { recursive: true });
  const opened = await openSqlite(target.path);
  return { dialect: target.dialect, sql: opened.db, close: opened.close };
}
