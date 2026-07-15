import { defineEnv, envField } from "@lesto/env";

import { clientEnv } from "./env.client";

/**
 * The typed environment, SPLIT into `server` and `client` halves. Read each value
 * off `env` (e.g. `env.LESTO_DB`, `env.PUBLIC_APP_NAME`) instead of `process.env`:
 * it is validated and typed, and a bad value fails at boot, not mid-request. Every
 * `envField` chains `.optional()` or `.default(value)`; a field with neither is
 * REQUIRED (boot throws if unset).
 *
 * SERVER vs CLIENT (the leak boundary):
 *   - `server` vars (secrets, the DB path) NEVER reach the browser. Read a server
 *     value in an `app/islands/*` component and it throws `ENV_SERVER_LEAK` LOUD +
 *     EARLY — a secret can't slip into client code.
 *   - `client` vars MUST be named `PUBLIC_*` (the leak contract). They live in the
 *     browser-safe `env.client.ts` (imported as `clientEnv`), so ONE schema feeds
 *     three places: this server validation, the island's `defineClientEnv`, and the
 *     bundler that inlines the values. `lesto build`/`dev` reads `env.client.ts` and
 *     bakes the `PUBLIC_*` literals into island code — no `process.env` in the browser.
 *
 * WHERE VALUES COME FROM:
 *   - Local dev: `lesto dev`/`build` run under Bun, which auto-loads `.env` and
 *     `.env.local` into `process.env` — so put secrets in `.env.local` (it is
 *     gitignored; commit a `.env.example` of the NAMES instead).
 *   - Cloudflare deploy: a Worker has no `process.env`. Read config off the Worker
 *     `env` binding (set with `wrangler secret put NAME`) and validate it the same
 *     way with `defineEnv(schema, workerEnv)` — pass the binding as the 2nd arg.
 */
export const env = defineEnv({
  server: {
    // The SQLite database file the app opens (see `lesto.app.ts`). Defaults to
    // `lesto.db` in the project root; point it elsewhere with `LESTO_DB=/path.db`.
    LESTO_DB: envField.string().default("lesto.db"),
    // Add server-only secrets here — e.g. SESSION_SECRET: envField.string().
    // They are validated at boot and NEVER shipped to the browser.
  },
  // The `PUBLIC_*` client schema, shared with the island + the bundler (env.client.ts).
  client: clientEnv,
});
