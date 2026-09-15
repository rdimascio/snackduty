import { openSqlite } from "@lesto/runtime";
import { buildApp, createApplication } from "../../app/lib/server/composition";
import { developmentIdentityServices } from "../../app/lib/server/identity";
import { devInviteDeliverer } from "../../app/lib/server/invite-delivery";

// Each suite owns its database; application imports never register globals.
export async function testApplication(clock: () => number = Date.now) {
  const { db: sql } = await openSqlite(":memory:");
  const { db, sessions } = await developmentIdentityServices(sql);
  const devInviteDelivery = devInviteDeliverer();
  const { config, services } = createApplication({
    sql,
    db,
    sessions,
    mode: "development",
    clock,
    developmentSignIn: true,
    inviteDelivery: devInviteDelivery,
  });
  return { default: config, services, devInviteDelivery, buildApp };
}
