import { openSqlite } from "@lesto/runtime";
import { env } from "./env";
import { createApplication } from "./app/lib/server/composition";
import { developmentIdentityServices } from "./app/lib/server/identity";
import { devInviteDeliverer } from "./app/lib/server/invite-delivery";

// Lesto invokes this factory per boot; importing it opens no database.
export default async function applicationConfig() {
  const { db: sql } = await openSqlite(env.LESTO_DB);
  const { db, sessions } = await developmentIdentityServices(sql);
  return createApplication({
    sql,
    db,
    sessions,
    clock: Date.now,
    mode: env.SNACKDAY_DEV_SIGN_IN ? "development" : "staging",
    developmentSignIn: env.SNACKDAY_DEV_SIGN_IN,
    inviteDelivery: devInviteDeliverer(),
  }).config;
}
