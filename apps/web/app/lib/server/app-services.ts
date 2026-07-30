import type { Sessions } from "@lesto/auth";
import type { Db } from "@lesto/db";

/**
 * The server-service registry file-routed page loaders read.
 *
 * Lesto's `PageDef.load` receives only the request `Context` — there is no
 * injection seam that hands a loader the app's database or sessions. So
 * `lesto.app.ts` registers the live services here when it boots, and a page
 * loader reads them back per request. The Cloudflare Worker (`worker.ts`)
 * bundles the page modules but never registers services — it has no filesystem
 * SQLite — so a loader running at the edge sees `undefined` and must degrade to
 * its signed-out/empty state.
 */
export interface AppServices {
  readonly db: Db;
  readonly sessions: Sessions;
}

let registered: AppServices | undefined;

export function provideAppServices(services: AppServices): void {
  registered = services;
}

export function appServices(): AppServices | undefined {
  return registered;
}
