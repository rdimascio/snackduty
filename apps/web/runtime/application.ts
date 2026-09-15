import type { Sessions } from "@lesto/auth";
import type { Db, SqlDatabase } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App, LestoAppConfig } from "@lesto/kernel";

import type { AppleIdentityVerifier, Clock } from "../app/lib/server/application-contracts";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import type { InviteDeliverer } from "../app/lib/server/invite-delivery";
import type { RuntimeConfiguration } from "./config";
import { openRuntimeDatabase } from "./database";
import type { RuntimeDatabase } from "./database";
import { unavailableInviteDeliverer } from "./delivery";
import { remoteSafetyPolicy } from "./surface";
import { registerRuntimePages, withRuntimeAssets } from "./web-surface";

export interface RuntimeApplicationAdapters {
  readonly clock?: Clock;
  readonly openDatabase?: (path: string) => Promise<RuntimeDatabase>;
  readonly createKernelApplication?: (config: LestoAppConfig) => Promise<App>;
  readonly inviteDelivery?: InviteDeliverer;
  readonly appleVerifier?: AppleIdentityVerifier;
}

export interface RuntimeApplication {
  readonly app: App;
  readonly db: Db;
  readonly sql: SqlDatabase;
  readonly sessions: Sessions;
  readonly migrationsApplied: readonly string[];
  close(): Promise<void>;
}

export async function openRuntimeApplication(
  configuration: RuntimeConfiguration,
  adapters: RuntimeApplicationAdapters = {},
): Promise<RuntimeApplication> {
  const database = await (adapters.openDatabase ?? openRuntimeDatabase)(configuration.databasePath);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await database.close();
  };

  try {
    const clock = adapters.clock ?? Date.now;
    const { db, sessions } = await identityServices(database.sql, { mode: "verified", clock });
    const inviteDelivery = adapters.inviteDelivery ?? unavailableInviteDeliverer();
    const application = createApplication({
      sql: database.sql,
      db,
      sessions,
      clock,
      mode: configuration.mode,
      developmentSignIn: false,
      inviteDelivery,
      exposeCalendarFeeds: configuration.upstreamCredentialPathLoggingSafe,
      ...(adapters.appleVerifier === undefined ? {} : { appleVerifier: adapters.appleVerifier }),
    });
    await registerRuntimePages(application.config.app);
    const kernel = await (adapters.createKernelApplication ?? createApp)(application.config);
    const app = remoteSafetyPolicy(withRuntimeAssets(kernel), {
      invitationDeliveryAvailable: adapters.inviteDelivery !== undefined,
      upstreamCredentialPathLoggingSafe: configuration.upstreamCredentialPathLoggingSafe,
    });

    return {
      app,
      db,
      sql: database.sql,
      sessions,
      migrationsApplied: kernel.migrationsApplied,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
