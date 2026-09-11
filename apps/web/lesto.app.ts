/**
 * The app: the LestoAppConfig that `lesto dev` boots — the migration chain, the
 * composed route surface, and the security posture, in one place.
 *
 * Every domain surface (identity, teams, roster, invitations, events,
 * attendance, duties, calendar feeds) is registered by its OWN module under
 * `app/lib/server/`, each owning its table, migration, and authorization.
 * Nothing is registered inline here, which is the property worth keeping: the
 * create-lesto starter's unauthenticated `/posts` API lived in this file and
 * would have shipped an anonymous write endpoint on the first public deploy.
 *
 * Routes read top-to-bottom like Hono/Express: one `lesto()` surface for both
 * API routes (`.get`/`.post`/…) and pages (`.page`), each handler a
 * `(c) => response` over the request context `c`.
 *
 * The HOME PAGE is NOT registered here — it lives at `app/routes/page.tsx` and is
 * auto-registered by Lesto's file-based routing (ADR 0023): drop a `page.tsx`
 * under `app/routes/` and its directory's URL becomes a route, no `.page()` call.
 * `lesto dev`/`build` scan that directory and compose every page onto THIS app.
 * Code-first routes and file routes live side by side on the same router.
 *
 * Two conventions worth seeing on day one:
 *   - Validation at the boundary (ADR 0005): the team handlers in
 *     `app/lib/server/teams.ts` run untrusted bodies through Zod schemas with
 *     `c.valid` before touching the database.
 *   - Security on by default, declared in one place: the config's `secure` field.
 *     Per-client rate-limiting is on from the kernel default, and `originCheck`
 *     adds zero-token CSRF — a state-changing request from another origin is
 *     refused (it reads the browser's `Sec-Fetch-Site`), with no token plumbing.
 */

import type { Sessions } from "@lesto/auth";
import type { Db } from "@lesto/db";

import { lesto } from "@lesto/web";
import { openSqlite } from "@lesto/runtime";
import type { LestoAppConfig } from "@lesto/kernel";

import { env } from "./env";
import { provideAppServices } from "./app/lib/server/app-services";
import {
  authenticatedAdult,
  createIdentity,
  developmentIdentityServices,
  devPersonaFromBody,
  DEV_SESSION_TTL_MS,
  developmentSessionCookie,
} from "./app/lib/server/identity";
import { devPersonaProvider } from "./app/lib/server/identity-providers";
import { registerAttendanceRoutes } from "./app/lib/server/attendance";
import { createCalendarFeeds, registerCalendarFeedRoutes } from "./app/lib/server/calendar-feeds";
import { createDuties, registerDutyRoutes } from "./app/lib/server/duties";
import { createEvents, registerEventRoutes } from "./app/lib/server/events";
import { devInviteDeliverer } from "./app/lib/server/invite-delivery";
import type { InviteDeliverer } from "./app/lib/server/invite-delivery";
import { createInvitations, registerInvitationRoutes } from "./app/lib/server/invitations";
import { registerRosterImportRoutes } from "./app/lib/server/roster-import";
import { createRoster, registerRosterRoutes } from "./app/lib/server/roster";
import { registerTeamReadRoutes } from "./app/lib/server/team-reads";
import { createTeamsAndSeasons, registerTeamRoutes } from "./app/lib/server/teams";

// The client/styles surface every route composes onto. Domain routes are
// registered by their own modules below — each owns its schema, migration, and
// authorization, so nothing unauthenticated is reachable from here.
//
// Migration versions start at 003: 001/002 were the create-lesto starter's
// `posts` table and its seed rows, deleted before first deploy. The migrator
// keys off a `schema_migrations` version LEDGER, not array position, so the gap
// is inert — a database that already applied them keeps a harmless orphan row.
function buildBaseApp() {
  return lesto().client("/client.js").styles("/styles.css");
}

export function buildApp(
  db: Db,
  sessions: Sessions,
  developmentSignIn: boolean,
  inviteDelivery: InviteDeliverer = devInviteDeliverer(),
) {
  const app = registerCalendarFeedRoutes(
    registerDutyRoutes(
      registerAttendanceRoutes(
        registerEventRoutes(
          registerInvitationRoutes(
            registerTeamReadRoutes(
              registerRosterImportRoutes(
                registerRosterRoutes(
                  registerTeamRoutes(buildBaseApp(), db, sessions),
                  db,
                  sessions,
                ),
                db,
                sessions,
              ),
              db,
              sessions,
            ),
            db,
            sessions,
            inviteDelivery,
          ),
          db,
          sessions,
        ),
        db,
        sessions,
      ),
      db,
      sessions,
    ),
    db,
    sessions,
  );

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

// The driver seam: `@lesto/runtime`'s `openSqlite` boots better-sqlite3 under
// Node and falls back to the built-in `bun:sqlite` under Bun — the framework
// owns that, so the app never has to. The same handle backs the kernel (which
// runs migrations) and the typed `@lesto/db` the handlers query through. The DB
// file comes from the typed env (`env.LESTO_DB`, default `lesto.db`) — see `env.ts`.
const { db: handle } = await openSqlite(env.LESTO_DB);
const { db, sessions } = await developmentIdentityServices(handle);

// The dev invite deliverer records each invitation's copyable link in memory
// (a real email adapter replaces it later). Exported so tests can assert the
// delivery payloads carry no child-sensitive data.
export const devInviteDelivery = devInviteDeliverer();

// File-routed page loaders (e.g. `app/routes/app/page.tsx`) read the db +
// sessions through this registry — `PageDef.load` receives only the request
// context. The Worker never registers services, so those loaders degrade to
// their signed-out state at the edge.
provideAppServices({ db, sessions });

const config: LestoAppConfig = {
  db: handle,
  app: buildApp(db, sessions, env.SNACKDAY_DEV_SIGN_IN, devInviteDelivery),
  migrations: [
    createIdentity,
    createTeamsAndSeasons,
    createRoster,
    createInvitations,
    createEvents,
    createCalendarFeeds,
    createDuties,
  ],
  // Security, declared in one place (ADR 0016). Per-client rate-limiting is ALREADY
  // on by the kernel default; `originCheck` layers zero-token CSRF over it — a
  // cross-site POST/PUT/PATCH/DELETE is refused at the door (it reads the browser's
  // `Sec-Fetch-Site`). Add `cors` / the signed-token `csrf`, retune `rateLimit`,
  // or set `secure: false` to opt out entirely.
  secure: { originCheck: {} },
  // The headline default (ADR 0011 Increment 3): `preact` ships a ~10 KB island
  // client. The single `ui.dialect` key drives BOTH the client bundle's
  // `react`→`preact/compat` alias (read by `lesto dev`/`build`) and — for a
  // bespoke worker — the server renderer. Switch to `"react"` to opt out.
  //
  // `ui.css` (ADR 0037) is the Tailwind v4 entry the CLI compiles to
  // `out/styles.css`. Its presence enables the CSS build; delete the key (and
  // `app/styles/app.css`) to ship no stylesheet. The build is read only by the CLI.
  ui: { dialect: "preact", css: "app/styles/app.css" },
};

export default config;
