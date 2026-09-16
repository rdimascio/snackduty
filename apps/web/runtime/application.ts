import type { SessionService as Sessions } from "../app/lib/server/application-contracts";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { openPostgres } from "@lesto/pg";
import { createApp } from "@lesto/kernel";
import type { App, LestoAppConfig } from "@lesto/kernel";

import type { AppleIdentityVerifier, Clock } from "../app/lib/server/application-contracts";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { createAppleIdentityVerifier } from "../app/lib/server/apple-identity";
import type {
  InvitationOutbox,
  InvitationPayloadCipher,
} from "../app/lib/server/invitation-outbox";
import type { InviteDeliverer } from "../app/lib/server/invite-delivery";
import type { RuntimeConfiguration } from "./config";
import { openRuntimeDatabase } from "./database";
import type { RuntimeDatabase, RuntimeDatabaseTarget } from "./database";
import { unavailableInviteDeliverer } from "./delivery";
import { remoteSafetyPolicy } from "./surface";
import { registerRuntimePages, withRuntimeAssets } from "./web-surface";
import { withRuntimeRelease } from "./release";

export interface RuntimeApplicationAdapters {
  readonly clock?: Clock;
  readonly openDatabase?: (target: RuntimeDatabaseTarget) => Promise<RuntimeDatabase>;
  readonly createKernelApplication?: (config: LestoAppConfig) => Promise<App>;
  readonly inviteDelivery?: InviteDeliverer;
  readonly appleVerifier?: AppleIdentityVerifier;
  readonly invitationCipher?: InvitationPayloadCipher;
}

export interface RuntimeApplication {
  readonly app: App;
  readonly db: Db;
  readonly sql: SqlDatabase;
  readonly sessions: Sessions;
  readonly migrationsApplied: readonly string[];
  readonly outbox: InvitationOutbox | undefined;
  close(): Promise<void>;
}

function runtimeDatabaseTarget(configuration: RuntimeConfiguration): RuntimeDatabaseTarget {
  return configuration.databaseDialect === "postgres"
    ? {
        dialect: "postgres",
        connectionString: configuration.databaseUrl,
        maxConnections: configuration.databasePoolMax,
      }
    : { dialect: "sqlite", path: configuration.databasePath };
}

export async function openRuntimeApplication(
  configuration: RuntimeConfiguration,
  adapters: RuntimeApplicationAdapters = {},
): Promise<RuntimeApplication> {
  const target = runtimeDatabaseTarget(configuration);
  const openDatabase =
    adapters.openDatabase ??
    ((requested: RuntimeDatabaseTarget) =>
      openRuntimeDatabase(
        requested,
        requested.dialect === "postgres"
          ? { openPostgres: (configuration) => openPostgres(configuration) }
          : {},
      ));
  const database = await openDatabase(target);
  if (database.dialect !== target.dialect) {
    await database.close();
    throw new Error("Runtime database opener returned a different SQL dialect than requested.");
  }
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await database.close();
  };

  try {
    const clock = adapters.clock ?? Date.now;
    const { sessions } = await identityServices(database.sql, { mode: "verified", clock });
    const db = createDb(database.sql, { dialect: database.dialect });
    const inviteDelivery = adapters.inviteDelivery ?? unavailableInviteDeliverer();
    const application = createApplication({
      sql: database.sql,
      db,
      sessions,
      clock,
      mode: configuration.mode,
      dialect: database.dialect,
      developmentSignIn: false,
      inviteDelivery,
      exposeCalendarFeeds: configuration.upstreamCredentialPathLoggingSafe,
      appleVerifier:
        adapters.appleVerifier ??
        createAppleIdentityVerifier({ audience: configuration.appleClientId, clock }),
      ...(adapters.invitationCipher === undefined
        ? {}
        : { invitationCipher: adapters.invitationCipher }),
    });
    await registerRuntimePages(application.config.app);
    const kernel = await (adapters.createKernelApplication ?? createApp)({
      ...application.config,
      dialect: database.dialect,
    });
    const app = remoteSafetyPolicy(
      withRuntimeRelease(withRuntimeAssets(kernel), configuration.release),
      {
        invitationDeliveryAvailable:
          adapters.inviteDelivery !== undefined && application.outbox !== undefined,
        upstreamCredentialPathLoggingSafe: configuration.upstreamCredentialPathLoggingSafe,
      },
    );

    return {
      app,
      db,
      sql: database.sql,
      sessions,
      migrationsApplied: kernel.migrationsApplied,
      outbox: application.outbox,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
