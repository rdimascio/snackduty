import type { Sessions } from "@lesto/auth";
import type { Db } from "@lesto/db";

import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";
import type { Clock } from "./application-contracts";
import type { LestoAppConfig } from "@lesto/kernel";

import { bindAppServices } from "./app-services";
import { createAuthentication, createAuthenticationSchema } from "./authentication";
import { registerSessionRoutes } from "./session-routes";
import {
  authenticatedAdult,
  createIdentity,
  devPersonaFromBody,
  DEV_SESSION_TTL_MS,
  developmentSessionCookie,
} from "./identity";
import { devPersonaProvider } from "./identity-providers";
import { registerAttendanceRoutes } from "./attendance";
import { createCalendarFeeds, registerCalendarFeedRoutes } from "./calendar-feeds";
import { createDuties, registerDutyRoutes } from "./duties";
import { createEvents, registerEventRoutes } from "./events";
import { devInviteDeliverer } from "./invite-delivery";
import type { InviteDeliverer } from "./invite-delivery";
import { createInvitations, registerInvitationRoutes } from "./invitations";
import { registerRosterImportRoutes } from "./roster-import";
import { createRoster, registerRosterRoutes } from "./roster";
import { registerTeamReadRoutes } from "./team-reads";
import { createTeamsAndSeasons, registerTeamRoutes } from "./teams";

// The client/styles surface every route composes onto. Domain routes are
// registered by their own modules below — each owns its schema, migration, and
// authorization, so nothing unauthenticated is reachable from here.
//
// Migration versions start at 003: 001/002 were the create-lesto starter's
// `posts` table and its seed rows, deleted before first deploy. The migrator
// keys off a `schema_migrations` version LEDGER, not array position, so the gap
// is inert — a database that already applied them keeps a harmless orphan row.
function buildBaseApp(db: Db, sessions: Sessions) {
  return lesto()
    .client("/client.js")
    .styles("/styles.css")
    .use((c, next) => {
      bindAppServices(c, { db, sessions });
      return next();
    });
}

export function buildApp(
  db: Db,
  sessions: Sessions,
  developmentSignIn: boolean,
  inviteDelivery: InviteDeliverer = devInviteDeliverer(),
  clock: Clock = Date.now,
  exposeCalendarFeeds = true,
) {
  let app: Lesto = buildBaseApp(db, sessions);
  app = registerTeamRoutes(app, db, sessions, clock);
  app = registerRosterRoutes(app, db, sessions);
  app = registerRosterImportRoutes(app, db, sessions);
  app = registerTeamReadRoutes(app, db, sessions);
  app = registerInvitationRoutes(app, db, sessions, inviteDelivery);
  app = registerEventRoutes(app, db, sessions, clock);
  app = registerAttendanceRoutes(app, db, sessions, clock);
  app = registerDutyRoutes(app, db, sessions, clock);
  if (exposeCalendarFeeds) app = registerCalendarFeedRoutes(app, db, sessions, clock);

  if (!developmentSignIn) return app;

  return app
    .post("/api/dev/sign-in", async (c) => {
      // No body → the default development adult (the historical behavior). A
      // body may ONLY select a persona from the bounded allowlist; anything
      // else keeps the historical generic rejection, so this endpoint can
      // never mint an arbitrary identity.
      const persona = devPersonaFromBody(c.req.body);
      if (persona === undefined) return c.json({ error: "request body is not allowed" }, 400);

      const identity = await devPersonaProvider.resolveAdult(db, {
        provider: "dev-persona",
        subject: persona,
      });
      if (identity === undefined) return c.json({ error: "request body is not allowed" }, 400);

      const session = await sessions.create(identity.account.id, DEV_SESSION_TTL_MS);

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": developmentSessionCookie(session.token),
        },
        body: JSON.stringify(identity),
      };
    })
    .get("/api/dev/session", async (c) => {
      const identity = await authenticatedAdult(db, sessions, c.header("cookie"));

      return identity === undefined
        ? c.json({ error: "authentication required" }, 401)
        : c.json(identity);
    });
}

export interface ApplicationOptions {
  readonly sql: import("@lesto/db").SqlDatabase;
  readonly db: Db;
  readonly sessions: Sessions;
  readonly clock: import("./application-contracts").Clock;
  readonly mode: "development" | "staging" | "production";
  readonly developmentSignIn: boolean;
  readonly inviteDelivery: InviteDeliverer;
  readonly exposeCalendarFeeds?: boolean;
  readonly appleVerifier?: import("./application-contracts").AppleIdentityVerifier;
}
export const applicationMigrations = [
  createIdentity,
  createTeamsAndSeasons,
  createRoster,
  createInvitations,
  createEvents,
  createCalendarFeeds,
  createDuties,
  createAuthenticationSchema,
];
/** Pure composition: callers own service lifecycle and provider selection. */
export function createApplication(options: ApplicationOptions) {
  if (options.mode !== "development" && options.developmentSignIn) {
    throw new Error("Development authentication requires development mode.");
  }
  const config: LestoAppConfig = {
    db: options.sql,
    app: registerSessionRoutes(
      buildApp(
        options.db,
        options.sessions,
        options.developmentSignIn,
        options.inviteDelivery,
        options.clock,
        options.exposeCalendarFeeds ?? options.mode === "development",
      ),
      createAuthentication({
        db: options.db,
        sessions: options.sessions,
        clock: options.clock,
        secureCookies: options.mode !== "development",
        ...(options.appleVerifier === undefined ? {} : { appleVerifier: options.appleVerifier }),
      }),
    ),
    migrations: applicationMigrations,
    secure: { originCheck: {} },
    ui: { dialect: "preact", css: "app/styles/app.css" },
  };
  return { config, services: { db: options.db, sessions: options.sessions } };
}
