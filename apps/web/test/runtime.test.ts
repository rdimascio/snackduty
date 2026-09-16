import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import type { RequestSpan, RequestTracer } from "@lesto/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { accounts, VERIFIED_SESSION_COOKIE, people } from "../app/lib/server/identity";
import { applicationMigrations } from "../app/lib/server/composition";
import {
  createSqliteBackup,
  openRuntimeDatabase,
  openRuntimeApplication,
  redactingRequestTracer,
  remoteSafetyPolicy,
  restoreSqliteBackup,
  runtimeConfiguration,
  RuntimeAdapterUnavailableError,
  RuntimeBackupError,
  RuntimeConfigurationError,
  RuntimeDatabaseDriverUnavailableError,
  startRuntimeServer,
  unavailableInviteDeliverer,
} from "../runtime";
import type { RuntimeConfiguration } from "../runtime";

const scratchDirectories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "snackduty-runtime-test-"));
  scratchDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function configuration(databasePath: string): RuntimeConfiguration {
  return {
    mode: "staging",
    databasePath,
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL("https://staging.snackduty.test"),
    appleClientId: "com.snackday.runtime-fixture",
    upstreamCredentialPathLoggingSafe: false,
  };
}

function body(response: { readonly body: string }): unknown {
  return JSON.parse(response.body);
}

async function seedAdult(runtime: Awaited<ReturnType<typeof openRuntimeApplication>>) {
  const now = "2026-09-14T12:00:00.000Z";
  await runtime.db
    .insert(people)
    .values({
      id: "person_runtime_probe",
      displayName: "Runtime Probe Adult",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await runtime.db
    .insert(accounts)
    .values({
      id: "account_runtime_probe",
      personId: "person_runtime_probe",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const session = await runtime.sessions.create("account_runtime_probe", 60_000);
  return `${VERIFIED_SESSION_COOKIE}=${session.token}`;
}

async function createTeam(
  runtime: Awaited<ReturnType<typeof openRuntimeApplication>>,
  cookie: string,
  name: string,
) {
  const response = await runtime.app.handle("POST", "/api/teams", {
    headers: { cookie, "sec-fetch-site": "same-origin" },
    body: { name },
  });
  expect(response.status).toBe(201);
}

describe("remote runtime configuration", () => {
  const valid = {
    SNACKDAY_RUNTIME_MODE: "staging",
    LESTO_DB: "/data/snackduty.db",
    SNACKDAY_PUBLIC_BASE_URL: "https://staging.snackduty.test",
    SNACKDAY_APPLE_CLIENT_ID: "com.snackday.runtime-fixture",
  };

  it("requires an explicit remote mode, durable absolute database path, and HTTPS origin", () => {
    expect(() => runtimeConfiguration(valid)).not.toThrow();
    expect(() => runtimeConfiguration({ ...valid, SNACKDAY_RUNTIME_MODE: undefined })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() => runtimeConfiguration({ ...valid, SNACKDAY_APPLE_CLIENT_ID: undefined })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() => runtimeConfiguration({ ...valid, SNACKDAY_RUNTIME_MODE: "development" })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() => runtimeConfiguration({ ...valid, LESTO_DB: "lesto.db" })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() => runtimeConfiguration({ ...valid, LESTO_DB: ":memory:" })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() => runtimeConfiguration({ ...valid, SNACKDAY_DEV_SIGN_IN: "true" })).toThrow(
      RuntimeConfigurationError,
    );
    expect(() =>
      runtimeConfiguration({ ...valid, SNACKDAY_PUBLIC_BASE_URL: "http://staging.invalid" }),
    ).toThrow(RuntimeConfigurationError);
    expect(() =>
      runtimeConfiguration({ ...valid, SNACKDAY_PUBLIC_BASE_URL: "https://staging.invalid/app" }),
    ).toThrow(RuntimeConfigurationError);
  });

  it("defaults to a container listener and withholds credential paths until explicitly safe", () => {
    expect(runtimeConfiguration(valid)).toMatchObject({
      mode: "staging",
      databasePath: "/data/snackduty.db",
      host: "0.0.0.0",
      port: 3_000,
      upstreamCredentialPathLoggingSafe: false,
    });
    expect(
      runtimeConfiguration({
        ...valid,
        PORT: "8080",
        SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE: "true",
      }),
    ).toMatchObject({ port: 8_080, upstreamCredentialPathLoggingSafe: true });
    expect(() => runtimeConfiguration({ ...valid, PORT: "0" })).toThrow(RuntimeConfigurationError);
    expect(() =>
      runtimeConfiguration({
        ...valid,
        SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE: "yes",
      }),
    ).toThrow(RuntimeConfigurationError);
  });

  it("selects PostgreSQL explicitly without treating its connection string as a file path", () => {
    const configured = runtimeConfiguration({
      ...valid,
      SNACKDAY_DATABASE_DIALECT: "postgres",
      LESTO_DB: undefined,
      DATABASE_URL: "postgresql://snackday:secret@db.internal/snackday?sslmode=require",
      SNACKDAY_DATABASE_POOL_MAX: "8",
    });

    expect(configured).toMatchObject({
      databaseDialect: "postgres",
      databaseUrl: "postgresql://snackday:secret@db.internal/snackday?sslmode=require",
      databasePoolMax: 8,
    });
    expect("databasePath" in configured).toBe(false);
  });

  it("rejects incomplete or malformed PostgreSQL configuration", () => {
    const postgres = {
      ...valid,
      SNACKDAY_DATABASE_DIALECT: "postgres",
      LESTO_DB: undefined,
    };

    expect(() => runtimeConfiguration(postgres)).toThrow(RuntimeConfigurationError);
    expect(() =>
      runtimeConfiguration({
        ...postgres,
        DATABASE_URL: "postgresql://db.internal/snackday?sslmode=verify-full&sslmode=disable",
      }),
    ).toThrow(RuntimeConfigurationError);
    expect(() =>
      runtimeConfiguration({ ...postgres, DATABASE_URL: "https://db.internal/db" }),
    ).toThrow(RuntimeConfigurationError);
    expect(() =>
      runtimeConfiguration({
        ...postgres,
        DATABASE_URL: "postgresql://db.internal/snackday",
        SNACKDAY_DATABASE_POOL_MAX: "0",
      }),
    ).toThrow(RuntimeConfigurationError);
    expect(() => runtimeConfiguration({ ...valid, SNACKDAY_DATABASE_DIALECT: "mysql" })).toThrow(
      RuntimeConfigurationError,
    );
  });
});

describe("runtime database selection", () => {
  const target = {
    dialect: "postgres" as const,
    connectionString: "postgresql://snackday:secret@db.internal/snackday?sslmode=require",
    maxConnections: 8,
  };

  it("fails closed when the PostgreSQL driver has not been wired", async () => {
    await expect(openRuntimeDatabase(target)).rejects.toBeInstanceOf(
      RuntimeDatabaseDriverUnavailableError,
    );
  });

  it("passes the bounded pool configuration to an injected PostgreSQL opener", async () => {
    const opened: unknown[] = [];
    const closed: string[] = [];
    const underlying = await openSqlite(":memory:");

    const database = await openRuntimeDatabase(target, {
      openPostgres: (configuration) => {
        opened.push(configuration);
        return Promise.resolve({
          db: underlying.db,
          close: () => {
            closed.push("closed");
            underlying.close();
          },
        });
      },
    });

    expect(opened).toEqual([
      {
        connectionString: target.connectionString,
        max: target.maxConnections,
      },
    ]);
    expect(database.dialect).toBe("postgres");
    await database.close();
    expect(closed).toEqual(["closed"]);
  });

  it("threads the selected dialect into the Lesto kernel configuration", async () => {
    const opened = await openSqlite(":memory:");
    let receivedTarget: unknown;
    let receivedDialect: unknown;

    const runtime = await openRuntimeApplication(
      {
        mode: "staging",
        databaseDialect: "postgres",
        databaseUrl: target.connectionString,
        databasePoolMax: target.maxConnections,
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: new URL("https://staging.snackduty.test"),
        appleClientId: "com.snackday.runtime-fixture",
        upstreamCredentialPathLoggingSafe: false,
      },
      {
        openDatabase(databaseTarget) {
          receivedTarget = databaseTarget;
          return Promise.resolve({ dialect: "postgres", sql: opened.db, close: opened.close });
        },
        createKernelApplication(config) {
          receivedDialect = config.dialect;
          return Promise.resolve({ migrationsApplied: [], handle: config.app.handle });
        },
      },
    );

    expect(receivedTarget).toEqual(target);
    expect(receivedDialect).toBe("postgres");
    await runtime.close();
  });

  it("closes and rejects an opener that returns the wrong dialect", async () => {
    const opened = await openSqlite(":memory:");
    let closed = false;

    await expect(
      openRuntimeApplication(
        {
          mode: "staging",
          databaseDialect: "postgres",
          databaseUrl: target.connectionString,
          databasePoolMax: target.maxConnections,
          host: "127.0.0.1",
          port: 0,
          publicBaseUrl: new URL("https://staging.snackduty.test"),
          appleClientId: "com.snackday.runtime-fixture",
          upstreamCredentialPathLoggingSafe: false,
        },
        {
          openDatabase() {
            return Promise.resolve({
              dialect: "sqlite",
              sql: opened.db,
              close() {
                closed = true;
                opened.close();
              },
            });
          },
        },
      ),
    ).rejects.toThrow("different SQL dialect");
    expect(closed).toBe(true);
  });
});

describe("remote safety policy", () => {
  const calls: string[] = [];
  const underlying: App = {
    migrationsApplied: ["003_create_identity"],
    handle(method, path) {
      calls.push(`${method} ${path}`);
      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    },
  };

  afterEach(() => calls.splice(0));

  it("withholds development auth, unsafe bearer feeds, and undeliverable invitations", async () => {
    const app = remoteSafetyPolicy(underlying, {
      invitationDeliveryAvailable: false,
      upstreamCredentialPathLoggingSafe: false,
    });

    expect((await app.handle("POST", "/api/dev/sign-in")).status).toBe(404);
    expect((await app.handle("GET", "/calendar/feed/secret")).status).toBe(404);
    expect((await app.handle("POST", "/api/teams/team_1/invitations")).status).toBe(503);
    expect((await app.handle("POST", "/api/teams/team_1/invitations/invite_1/resend")).status).toBe(
      503,
    );
    expect(calls).toEqual([]);
  });

  it("delegates proven surfaces to the canonical application", async () => {
    const app = remoteSafetyPolicy(underlying, {
      invitationDeliveryAvailable: true,
      upstreamCredentialPathLoggingSafe: true,
    });

    expect((await app.handle("GET", "/calendar/feed/token")).status).toBe(200);
    expect((await app.handle("POST", "/api/teams/team_1/invitations")).status).toBe(200);
    expect(calls).toEqual(["GET /calendar/feed/token", "POST /api/teams/team_1/invitations"]);
  });
});

describe("remote adapters", () => {
  it("fails invitation delivery visibly instead of recording fake success", async () => {
    const deliverer = unavailableInviteDeliverer();
    await expect(
      deliverer.deliver({
        invitationId: "invite_1",
        teamName: "Falcons",
        inviterDisplayName: "Coach",
        invitedRole: "adult",
        inviteUrl: "/invite#secret",
      }),
    ).rejects.toBeInstanceOf(RuntimeAdapterUnavailableError);
    expect(deliverer.currentLink("invite_1")).toBeUndefined();
  });

  it("redacts credential paths before they enter trace attributes", () => {
    const attributes: Array<[string, unknown]> = [];
    const span: RequestSpan = {
      data: { traceId: "1".repeat(32), spanId: "2".repeat(16) },
      setAttribute(key, value) {
        attributes.push([key, value]);
      },
      setStatus() {},
      end() {},
    };
    const tracer: RequestTracer = { startSpan: () => span };
    const safe = redactingRequestTracer(tracer).startSpan("http.request");

    safe.setAttribute("http.path", "/calendar/feed/raw-token");
    safe.setAttribute("http.method", "GET");

    expect(attributes).toEqual([
      ["http.path", "/calendar/feed/[redacted]"],
      ["http.method", "GET"],
    ]);
  });
});

describe("durable Bun application", () => {
  it("runs real migrations and APIs, restores sessions after restart, and restores a backup", async () => {
    const directory = await scratchDirectory();
    const databasePath = join(directory, "live", "snackduty.db");
    const backupPath = join(directory, "backups", "before-second-team.db");
    const restoredPath = join(directory, "restored", "snackduty.db");
    const options = configuration(databasePath);

    const first = await openRuntimeApplication(options);
    expect(first.migrationsApplied).toEqual(
      applicationMigrations.map((migration) => migration.version),
    );
    expect((await first.app.handle("POST", "/api/dev/sign-in")).status).toBe(404);

    const cookie = await seedAdult(first);
    const sessionResponse = await first.app.handle("GET", "/api/session", { headers: { cookie } });
    expect(sessionResponse.status).toBe(200);
    expect(JSON.stringify(body(sessionResponse))).toContain("account_runtime_probe");
    const page = await first.app.handle("GET", "/app", { headers: { cookie } });
    expect(page.status).toBe(200);
    const invitePage = await first.app.handle("GET", "/invite");
    expect(invitePage.status).toBe(200);
    await createTeam(first, cookie, "Persistent Falcons");
    await first.close();

    const restarted = await openRuntimeApplication(options);
    expect(restarted.migrationsApplied).toEqual([]);
    const listed = await restarted.app.handle("GET", "/api/teams", { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(body(listed))).toContain("Persistent Falcons");

    const backup = await createSqliteBackup(restarted.sql, databasePath, backupPath);
    expect(backup.integrity).toBe("ok");
    expect(backup.backupBytes).toBeGreaterThan(0);
    await expect(
      createSqliteBackup(restarted.sql, databasePath, backupPath),
    ).rejects.toBeInstanceOf(RuntimeBackupError);
    await expect(
      restoreSqliteBackup(join(directory, "missing.db"), join(directory, "not-restored.db")),
    ).rejects.toBeInstanceOf(RuntimeBackupError);
    await createTeam(restarted, cookie, "Post-backup Comets");
    await restarted.close();

    const restore = await restoreSqliteBackup(backupPath, restoredPath);
    expect(restore.integrity).toBe("ok");
    const restored = await openRuntimeApplication(configuration(restoredPath));
    const restoredList = await restored.app.handle("GET", "/api/teams", { headers: { cookie } });
    const restoredBody = JSON.stringify(body(restoredList));
    expect(restoredBody).toContain("Persistent Falcons");
    expect(restoredBody).not.toContain("Post-backup Comets");
    await restored.close();
  });

  it("serves Lesto liveness and database readiness over HTTP", async () => {
    const directory = await scratchDirectory();
    const running = await startRuntimeServer(configuration(join(directory, "snackduty.db")));

    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      const readiness = await fetch(`http://127.0.0.1:${running.port}/readyz`);
      expect(health.status).toBe(200);
      expect(readiness.status).toBe(200);
      expect(await health.text()).toBe("ok");
      expect(await readiness.text()).toBe("ready");
    } finally {
      await running.stop();
    }
  });
});
