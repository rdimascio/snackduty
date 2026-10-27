# Snackday engineering guide

Snackday is a Bun monorepo for a Lesto web application and a native SwiftUI iOS application.

## Commands

- Install dependencies with `bun install`.
- Run all checks with `bun run gate`.
- Format with `bun run format`; lint with `bun run lint`.
- Run a workspace script with `bun run --filter <workspace> <script>`.
- Boot a seeded local scenario with `bun run dev:scenario`; it prints the `/dev/sign-in` link and is ready in about a second. `bun run check:scenario` seeds, verifies every role over HTTP, and tears it down.

## Dev seed and roles

- `seed/` holds numbered SQL files (`001_people.sql` … `009_calendar_feeds.sql`). `apps/web/app/dev/seed-database.ts` creates a new SQLite file, runs `installSessionSchema` and `applicationMigrations`, then applies every `NNN_name.sql` in name order in one transaction, before `lesto dev` boots. The seed is dev-only and SQLite-only: dates use SQLite `date()`/`strftime()` relative to now, and production (Postgres) never runs it.
- Seeded teams run in `America/Phoenix` (no DST), so `starts_at_utc` is local time plus seven hours. Events cover today through the next three weeks: a Tue/Thu Falcons practice series, three Saturday games (one cancelled), and one Comets clinic.
- The seed also holds open and claimed duty slots on games and the next three practices, guardian RSVPs, a week of `skill.events/v0` for Avery (a few days for Blake), two pending Falcons invitations, and Pat Parent's Falcons calendar feed. Invitation and feed tokens are fixed synthetic values; the scenario start-up text prints their links.
- `apps/web/app/dev/seed-personas.ts` is the one module for seeded ids: `SEED_PERSONAS`, `SEED_TEAMS`, `SEED_CHILDREN`, `SEED_INVITATIONS`, `SEED_CALENDAR_FEED`, `SEED_SCHEDULE`. Keep the ids stable; end-to-end tests import them. Emails are labels only: the seed writes no `verified_identity_emails`, because a dev identity never proves an email.
- Roles. Sign in at `/dev/sign-in` (one button per role) or `POST /api/dev/sign-in` with `{"persona": "<key>"}`. No body signs in `default`.

| Persona key            | Role                                                                 | Adult                    | Email                                |
| ---------------------- | -------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| `head-coach`           | Falcons owner (head coach)                                           | Hana Headcoach           | `head-coach@snackday.test`           |
| `co-coach`             | Falcons co-coach                                                     | Cole Cocoach             | `co-coach@snackday.test`             |
| `parent`               | Guardian of Avery and Blake on the Falcons                           | Pat Parent               | `parent@snackday.test`               |
| `second-team-guardian` | Guardian of Quinn on the Comets only                                 | Gwen Guardian            | `second-team-guardian@snackday.test` |
| `team-member`          | Falcons adult with no child                                          | Max Member               | `team-member@snackday.test`          |
| `stranger`             | Signed in, no team, one pending invitation                           | Sid Stranger             | `stranger@snackday.test`             |
| `default`              | Comets owner; iOS live tests                                         | Development Adult        | `development-adult@snackday.test`    |
| `second-adult`         | Falcons co-coach and Jordan's guardian on the Comets; iOS live tests | Second Development Adult | `second-adult@snackday.test`         |

- Ballplayer uses the same accounts: `parent` sees guardian cards and `head-coach` sees read-only coach cards on `ballplayer.localhost`. Sessions stay per host, so sign in again on that host.
- `apps/web/app/dev/sign-in.ts` wraps `app.handle` in `lesto.app.ts` to serve the seed-only personas and registers `/dev/sign-in` with `app.page()`; `default` and `second-adult` fall through to the `/api/dev/sign-in` route in `lib/server/composition.ts`. Both exist only when `SNACKDAY_DEV_SIGN_IN=true`.
- Add seed data: add rows to the file for that area, or add the next numbered file. Use fixed ids that start with the table prefix plus `_seed_`, relative dates, and `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` for timestamps. Add any id a test needs to `seed-personas.ts`. Write no SQL comments. Then run `bun run --filter web test test/dev-seed-schema.test.ts test/dev-seed-roles.test.ts`.
- `apps/web/test/dev-seed-schema.test.ts` applies the seed to a freshly migrated database and fails when a column or table changes under it; it also checks that occurrences match `scheduleDates`, that skill events parse, and that token hashes match. `apps/web/test/dev-seed-roles.test.ts` signs in every role and checks its team access.

## Conventions

- Use strict TypeScript and ESM. Do not weaken compiler or lint rules to land a change.
- Keep `Person`, `Account`, `Household`, `Participant`, and team membership as separate domain concepts. Children do not require accounts.
- Authorize every server-side operation; client visibility is not an authorization boundary.
- Player cards: a coach (a role holding `roster.manage`) reads, read-only, the card of a child with an active membership in an active season of that team (`mayReadParticipantCard`). Every write (lesson answers, skill events, the seed route) stays guardian-only through `mayManageParticipant`.
- `apps/web/app/dev/` holds development-only routes, the seed runner and the role sign-in. `POST /api/dev/teams/:teamId/participants/:participantId/skill-events`, the role sign-in and `/dev/sign-in` are registered from `apps/web/lesto.app.ts` only when `SNACKDAY_DEV_SIGN_IN=true`; the production runtime and Worker never import `app/dev`, and `apps/web/test/dev-skill-events-flag.test.ts` checks that they answer 404 there. The seed route and the SQL seed are the only paths that may backdate a skill event.
- `patches/@lesto%2Fobservability@0.2.0.patch` stops the browser RUM client from recording a resource span for its own `POST /__lesto/browser-spans`; without it, every sampled tab posts in a loop in every mode. Keep `@lesto/observability` pinned to the patched version, and keep one rate limiter for every request in every mode. `apps/web/test/rum-beacon-loop.test.ts` guards it.
- Queue side effects must be idempotent and persist their state before delivery.
- Never include child-sensitive data in logs, analytics, or notification previews.
- Use `apply_patch` for deliberate source edits and preserve unrelated work in the shared worktree.
- Infrastructure conventions come from the sibling Lesto repository at `../crack`; read its `AGENTS.md`, `ARCHITECTURE.md`, and `CONVENTIONS.md` before changing infrastructure.

## Brands

- One app serves two brands: Snackday and Ballplayer. Same deploy, data model, and accounts; sessions stay per host.
- `apps/web/app/brand/brand.ts` picks the brand from the request `Host` header only. `ballplayer.co`, `www.ballplayer.co`, and the dev host `ballplayer.localhost` (any port, any case) are Ballplayer; every other or missing host is Snackday. Never read `X-Forwarded-Host` for the brand.
- `apps/web/app/server/brand-routing.ts` is the one wiring point. `routeBrands` only routes; it wraps the Lesto app in dev (`lesto.app.ts`) and production (`registerRuntimePages` in `runtime/web-surface.ts`). On the Ballplayer host, `GET /` renders `app/ballplayer/home-page.tsx` with no layouts and no client bundle, and `/fonts/*` serves `public/fonts`. Only the platform allowlist in that file (`/api/*`, `/__lesto/*`, `/styles.css`, `/client.js`) falls through to the shared app; every other Ballplayer-host request gets a plain 404 until Ballplayer has its own pages.
- Ballplayer styles live in `app/styles/app.css`, scoped by `data-brand="ballplayer"` on the page shell. Fonts are self-hosted under `public/fonts` with their OFL licenses. Load nothing from another origin and add no analytics to Ballplayer.
- Open Ballplayer locally: run `bun run --filter web dev`, then open `http://ballplayer.localhost:<port>/`.
- Every response from the app handler carries a strict Content-Security-Policy on both brands, from `apps/web/app/server/content-security-policy.ts`: `BALLPLAYER_CONTENT_SECURITY_POLICY` on the Ballplayer host and `SNACKDAY_CONTENT_SECURITY_POLICY` on every other host. Every directive is `'self'` or `'none'`; the only other origin is `REEL_MEDIA_ORIGIN` (lesson posters), in Snackday's `img-src` only. Production applies it once, outermost, in `openRuntimeApplication` (`runtime/application.ts`), around the remote safety policy, release and asset wrappers; dev applies it with `secureBrands` in `lesto.app.ts`; the Cloudflare Worker (`worker.ts`) applies it with `withBrandSecurityFetch` around both the `ASSETS` binding and the app handler. Never rewrite the HTML body to satisfy the policy. Lesto's `[data-lesto-layout]` wrapper still carries an inline `style="display:contents"`; the policy blocks it and `app/styles/app.css` sets that display instead. It is the only inline style allowed until `@lesto/web` emits the wrapper without one. Island state stays in `type="application/json"` blocks, which the policy does not execute. Responses the `@lesto/runtime` transport writes itself (`/health`, `/readyz`, and its own 400, 413, 500 and 503 answers) and dev-server assets (`/styles.css`, `/@lesto-dev/*`) are outside the app handler and carry no policy.
- The policy protects minors on both brands. Do not loosen it (no new source or origin, `unsafe-*`, `data:`, `*`, hash, nonce, or removed directive) without Ryan's explicit yes. A page that needs a script or style gets it from a file on this origin.
- `lesto dev` appends inline live-reload and AI-overlay scripts and opens its HMR websocket on a second port, so the policy blocks them on every host in dev. `bun run check:csp-browser` builds the client, applies the SQL seed plus a 60-player roster, serves the app handler without those dev tools, and fails on any CSP violation except the blocked layout wrapper style on `/`, `/features`, `/dev/sign-in`, `/app`, `/app/schedule` and `/app/duties` (as `head-coach` and `parent` each), `/invite` and the Ballplayer home.

## Repository layout

- `apps/web`: one Lesto origin for the marketing site and signed-in product.
  `apps/web/public/styles.css` is a committed symlink to `out/styles.css`: in `lesto dev`, Vite rewrites the page's `/styles.css` link to `/@lesto-dev/styles.css` and serves it from `public/`. Production does not read `public/`.
- `apps/ios`: native SwiftUI application and Xcode project (planned).
- `packages/domain`: framework-independent domain types, schemas, policies, and tests.
- `docs`: product, architecture, privacy, and decision records.
