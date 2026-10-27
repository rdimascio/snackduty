# Snackday engineering guide

Snackday is a Bun monorepo for a Lesto web application and a native SwiftUI iOS application.

## Commands

- Install dependencies with `bun install`.
- Run all checks with `bun run gate`.
- Format with `bun run format`; lint with `bun run lint`.
- Run a workspace script with `bun run --filter <workspace> <script>`.

## Conventions

- Use strict TypeScript and ESM. Do not weaken compiler or lint rules to land a change.
- Keep `Person`, `Account`, `Household`, `Participant`, and team membership as separate domain concepts. Children do not require accounts.
- Authorize every server-side operation; client visibility is not an authorization boundary.
- Queue side effects must be idempotent and persist their state before delivery.
- Never include child-sensitive data in logs, analytics, or notification previews.
- Use `apply_patch` for deliberate source edits and preserve unrelated work in the shared worktree.
- Infrastructure conventions come from the sibling Lesto repository at `../crack`; read its `AGENTS.md`, `ARCHITECTURE.md`, and `CONVENTIONS.md` before changing infrastructure.

## Brands

- One app serves two brands: Snackday and Ballplayer. Same deploy, data model, and accounts; sessions stay per host.
- `apps/web/app/brand/brand.ts` picks the brand from the request `Host` header only. `ballplayer.co`, `www.ballplayer.co`, and the dev host `ballplayer.localhost` (any port, any case) are Ballplayer; every other or missing host is Snackday. Never read `X-Forwarded-Host` for the brand.
- `apps/web/app/server/brand-routing.ts` is the one wiring point. `routeBrands` wraps the Lesto app in dev (`lesto.app.ts`) and production (`registerRuntimePages` in `runtime/web-surface.ts`); `withRuntimeAssets` adds the policy to static assets. On the Ballplayer host, `GET /` renders `app/ballplayer/home-page.tsx` with no layouts and no client bundle, and `/fonts/*` serves `public/fonts`; other paths fall through to the Snackday routes.
- Ballplayer styles live in `app/styles/app.css`, scoped by `data-brand="ballplayer"` on the page shell. Fonts are self-hosted under `public/fonts` with their OFL licenses. Load nothing from another origin and add no analytics to Ballplayer.
- Open Ballplayer locally: run `bun run --filter web dev`, then open `http://ballplayer.localhost:<port>/`. The dev live-reload scripts are inline, so the policy blocks them on that host.
- Every Ballplayer-brand response carries `CONTENT_SECURITY_POLICY` from `apps/web/app/server/content-security-policy.ts`. Do not loosen that policy (no new source, `unsafe-*`, `data:`, or removed directive) without Ryan's explicit yes. Snackday responses carry no policy from this code; Snackday's own policy is a separate change.

## Repository layout

- `apps/web`: one Lesto origin for the marketing site and signed-in product.
  `apps/web/public/styles.css` is a committed symlink to `out/styles.css`: in `lesto dev`, Vite rewrites the page's `/styles.css` link to `/@lesto-dev/styles.css` and serves it from `public/`. Production does not read `public/`.
- `apps/ios`: native SwiftUI application and Xcode project (planned).
- `packages/domain`: framework-independent domain types, schemas, policies, and tests.
- `docs`: product, architecture, privacy, and decision records.
