# Snackday engineering guide

Snackday is a Bun monorepo for a Lesto web application and a native SwiftUI iOS application.

## Commands

- Install dependencies with `bun install`.
- Run all checks with `bun run gate`.
- Format with `bun run format`; lint with `bun run lint`.
- Run a workspace script with `bun run --filter <workspace> <script>`.
- Boot a seeded local scenario with `bun run dev:scenario`; `bun run check:scenario` seeds, verifies, and tears it down. The scenario also posts a week of `skill.events/v0` drills ending today through the dev-only seed route, so the player card shows a positive overall and a current streak.

## Conventions

- Use strict TypeScript and ESM. Do not weaken compiler or lint rules to land a change.
- Keep `Person`, `Account`, `Household`, `Participant`, and team membership as separate domain concepts. Children do not require accounts.
- Authorize every server-side operation; client visibility is not an authorization boundary.
- Player cards: a coach (a role holding `roster.manage`) reads, read-only, the card of a child with an active membership in an active season of that team (`mayReadParticipantCard`). Every write (lesson answers, skill events, the seed route) stays guardian-only through `mayManageParticipant`.
- `apps/web/app/dev/` holds development-only routes. `POST /api/dev/teams/:teamId/participants/:participantId/skill-events` is registered from `apps/web/lesto.app.ts` only when `SNACKDAY_DEV_SIGN_IN=true`; the production runtime and Worker never import `app/dev`. It is the only path that may backdate a skill event.
- Queue side effects must be idempotent and persist their state before delivery.
- Never include child-sensitive data in logs, analytics, or notification previews.
- Use `apply_patch` for deliberate source edits and preserve unrelated work in the shared worktree.
- Infrastructure conventions come from the sibling Lesto repository at `../crack`; read its `AGENTS.md`, `ARCHITECTURE.md`, and `CONVENTIONS.md` before changing infrastructure.

## Brands

- One app serves two brands: Snackday and Ballplayer. Same deploy, data model, and accounts; sessions stay per host.
- `apps/web/app/brand/brand.ts` picks the brand from the request `Host` header only. `ballplayer.co`, `www.ballplayer.co`, and the dev host `ballplayer.localhost` (any port, any case) are Ballplayer; every other or missing host is Snackday. Never read `X-Forwarded-Host` for the brand.
- `apps/web/app/server/brand-routing.ts` is the one wiring point. `routeBrands` only routes; it wraps the Lesto app in dev (`lesto.app.ts`) and production (`registerRuntimePages` in `runtime/web-surface.ts`). On the Ballplayer host, `GET /` renders `app/ballplayer/home-page.tsx` with no layouts and no client bundle, and `/fonts/*` serves `public/fonts`. Only the platform allowlist in that file (`/api/*`, `/__lesto/*`, `/styles.css`, `/client.js`) falls through to the shared app; every other Ballplayer-host request gets a plain 404 until Ballplayer has its own pages.
- Ballplayer styles live in `app/styles/app.css`, scoped by `data-brand="ballplayer"` on the page shell. Fonts are self-hosted under `public/fonts` with their OFL licenses. Load nothing from another origin and add no analytics to Ballplayer.
- Open Ballplayer locally: run `bun run --filter web dev`, then open `http://ballplayer.localhost:<port>/`. The dev live-reload scripts are inline, so the policy blocks them on that host.
- Ballplayer-host responses from the app handler carry `CONTENT_SECURITY_POLICY` from `apps/web/app/server/content-security-policy.ts`. Production applies it once, outermost, in `openRuntimeApplication` (`runtime/application.ts`), around the remote safety policy, release and asset wrappers; dev applies it with `secureBrands` in `lesto.app.ts`. Responses the `@lesto/runtime` transport writes itself (`/health`, `/readyz`, and its own 400, 413, 500 and 503 answers) and dev-server assets (`/styles.css`, `/@lesto-dev/*`) are outside the app handler and carry no policy. Do not loosen that policy (no new source, `unsafe-*`, `data:`, or removed directive) without Ryan's explicit yes. Snackday responses carry no policy from this code; Snackday's own policy is a separate change.

## Repository layout

- `apps/web`: one Lesto origin for the marketing site and signed-in product.
  `apps/web/public/styles.css` is a committed symlink to `out/styles.css`: in `lesto dev`, Vite rewrites the page's `/styles.css` link to `/@lesto-dev/styles.css` and serves it from `public/`. Production does not read `public/`.
- `apps/ios`: native SwiftUI application and Xcode project (planned).
- `packages/domain`: framework-independent domain types, schemas, policies, and tests.
- `docs`: product, architecture, privacy, and decision records.
