import { openSqlite } from "@lesto/runtime";
import { buildApp, createApplication } from "../../app/lib/server/composition";
import { identityServices } from "../../app/lib/server/identity";
import { devInviteDeliverer } from "../../app/lib/server/invite-delivery";
import { aesGcmInvitationPayloadCipher } from "../../app/lib/server/invitation-outbox";

// Each suite owns its database; application imports never register globals.
export async function testApplication(clock: () => number = Date.now) {
  const { db: sql } = await openSqlite(":memory:");
  const { db, sessions } = await identityServices(sql, { mode: "development", clock });
  const devInviteDelivery = devInviteDeliverer();
  const { config, services } = createApplication({
    sql,
    db,
    sessions,
    mode: "development",
    clock,
    developmentSignIn: true,
    inviteDelivery: devInviteDelivery,
    invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
  });
  return { default: config, services, devInviteDelivery, buildApp };
}
