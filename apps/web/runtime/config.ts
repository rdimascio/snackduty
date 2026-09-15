import { isAbsolute, resolve } from "node:path";

export type RemoteRuntimeMode = "staging" | "production";

interface SharedRuntimeConfiguration {
  readonly mode: RemoteRuntimeMode;
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: URL;
  readonly appleClientId: string;
  readonly upstreamCredentialPathLoggingSafe: boolean;
}

export interface SqliteRuntimeConfiguration extends SharedRuntimeConfiguration {
  readonly databaseDialect?: "sqlite";
  readonly databasePath: string;
}

export interface PostgresRuntimeConfiguration extends SharedRuntimeConfiguration {
  readonly databaseDialect: "postgres";
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
}

export type RuntimeConfiguration = SqliteRuntimeConfiguration | PostgresRuntimeConfiguration;

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export class RuntimeConfigurationError extends Error {
  readonly code = "RUNTIME_CONFIGURATION_INVALID";
}

function required(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new RuntimeConfigurationError(`${name} is required for the remote runtime.`);
  }

  return value;
}

function runtimeMode(value: string): RemoteRuntimeMode {
  if (value === "staging" || value === "production") return value;

  throw new RuntimeConfigurationError(
    "SNACKDAY_RUNTIME_MODE must be either staging or production.",
  );
}

function databasePath(value: string): string {
  if (value === ":memory:" || !isAbsolute(value)) {
    throw new RuntimeConfigurationError(
      "LESTO_DB must be an absolute path on the remote runtime's persistent volume.",
    );
  }

  return resolve(value);
}

function databaseDialect(value: string | undefined): "sqlite" | "postgres" {
  if (value === undefined || value.trim() === "" || value === "sqlite") return "sqlite";
  if (value === "postgres") return value;

  throw new RuntimeConfigurationError(
    "SNACKDAY_DATABASE_DIALECT must be either sqlite or postgres.",
  );
}

function databaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeConfigurationError("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname === "" ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.hash !== ""
  ) {
    throw new RuntimeConfigurationError("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  return value;
}

function databasePoolMax(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 10;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new RuntimeConfigurationError(
      "SNACKDAY_DATABASE_POOL_MAX must be an integer between 1 and 100.",
    );
  }

  return parsed;
}

function port(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3_000;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RuntimeConfigurationError("PORT must be an integer between 1 and 65535.");
  }

  return parsed;
}

function publicBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeConfigurationError("SNACKDAY_PUBLIC_BASE_URL must be a valid HTTPS URL.");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.hash !== "" ||
    parsed.search !== ""
  ) {
    throw new RuntimeConfigurationError(
      "SNACKDAY_PUBLIC_BASE_URL must be an HTTPS origin without credentials, query, or fragment.",
    );
  }

  return parsed;
}

function explicitBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;

  throw new RuntimeConfigurationError(`${name} must be true or false when set.`);
}

export function runtimeConfiguration(environment: RuntimeEnvironment): RuntimeConfiguration {
  if (explicitBoolean(environment["SNACKDAY_DEV_SIGN_IN"], "SNACKDAY_DEV_SIGN_IN")) {
    throw new RuntimeConfigurationError(
      "Development authentication is forbidden in the remote runtime.",
    );
  }
  const shared = {
    mode: runtimeMode(required(environment, "SNACKDAY_RUNTIME_MODE")),
    host: environment["HOST"]?.trim() || "0.0.0.0",
    port: port(environment["PORT"]),
    publicBaseUrl: publicBaseUrl(required(environment, "SNACKDAY_PUBLIC_BASE_URL")),
    appleClientId: required(environment, "SNACKDAY_APPLE_CLIENT_ID"),
    upstreamCredentialPathLoggingSafe: explicitBoolean(
      environment["SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE"],
      "SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE",
    ),
  };
  const dialect = databaseDialect(environment["SNACKDAY_DATABASE_DIALECT"]);

  return dialect === "postgres"
    ? {
        ...shared,
        databaseDialect: dialect,
        databaseUrl: databaseUrl(required(environment, "DATABASE_URL")),
        databasePoolMax: databasePoolMax(environment["SNACKDAY_DATABASE_POOL_MAX"]),
      }
    : {
        ...shared,
        databaseDialect: dialect,
        databasePath: databasePath(required(environment, "LESTO_DB")),
      };
}
