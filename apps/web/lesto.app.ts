import { openSqlite } from "@lesto/runtime";
import { env } from "./env";
import { createApplication } from "./app/lib/server/composition";
import { identityServices } from "./app/lib/server/identity";
import { devInviteDeliverer } from "./app/lib/server/invite-delivery";
import { createAppleIdentityVerifier } from "./app/lib/server/apple-identity";
import { unavailableInviteDeliverer } from "./runtime/delivery";
import { runtimeConfiguration } from "./runtime/config";

// Lesto invokes this factory per boot; importing it opens no database.
export default async function applicationConfig() {
  const mode = env.SNACKDAY_RUNTIME_MODE;
  if (mode !== "development" && mode !== "staging" && mode !== "production") {
    throw new Error("SNACKDAY_RUNTIME_MODE must be development, staging, or production.");
  }
  if (mode !== "development") runtimeConfiguration(process.env);
  const { db: sql } = await openSqlite(env.LESTO_DB);
  const { db, sessions } = await identityServices(sql, {
    mode: mode === "development" ? "development" : "verified",
    clock: Date.now,
  });
  const audience = env.SNACKDAY_APPLE_CLIENT_ID?.trim();
  return createApplication({
    sql,
    db,
    sessions,
    clock: Date.now,
    mode,
    developmentSignIn: env.SNACKDAY_DEV_SIGN_IN,
    inviteDelivery: mode === "development" ? devInviteDeliverer() : unavailableInviteDeliverer(),
    ...(audience ? { appleVerifier: createAppleIdentityVerifier({ audience }) } : {}),
  }).config;
}
