import { isAbsolute, resolve } from "node:path";

export type RemoteRuntimeMode = "staging" | "production";

export interface RuntimeConfiguration {
  readonly mode: RemoteRuntimeMode;
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: URL;
  readonly appleClientId: string;
  readonly upstreamCredentialPathLoggingSafe: boolean;
}

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
  return {
    mode: runtimeMode(required(environment, "SNACKDAY_RUNTIME_MODE")),
    databasePath: databasePath(required(environment, "LESTO_DB")),
    host: environment["HOST"]?.trim() || "0.0.0.0",
    port: port(environment["PORT"]),
    publicBaseUrl: publicBaseUrl(required(environment, "SNACKDAY_PUBLIC_BASE_URL")),
    appleClientId: required(environment, "SNACKDAY_APPLE_CLIENT_ID"),
    upstreamCredentialPathLoggingSafe: explicitBoolean(
      environment["SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE"],
      "SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE",
    ),
  };
}
