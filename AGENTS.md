# Snackday engineering guide

Snackday is a Bun monorepo for a Lesto web application and a native SwiftUI iOS application.

## Commands

- Install dependencies with `bun install`.
- Run all checks with `bun run gate`.
- Format with `bun run format`; lint with `bun run lint`.
- Run a workspace script with `bun run --filter <workspace> <script>`.
- Boot a seeded local scenario with `bun run dev:scenario`; `bun run check:scenario` seeds, verifies, and tears it down. Both answer the live lesson of the week, so they need network access to `learn.dimasciobaseball.com`. The scenario also posts a week of `skill.events/v0` drills ending today through the dev-only seed route, so the player card shows a positive overall and a current streak.

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

## Repository layout

- `apps/web`: one Lesto origin for the marketing site and signed-in product.
  `apps/web/public/styles.css` is a committed symlink to `out/styles.css`: in `lesto dev`, Vite rewrites the page's `/styles.css` link to `/@lesto-dev/styles.css` and serves it from `public/`. Production does not read `public/`.
- `apps/ios`: native SwiftUI application and Xcode project (planned).
- `packages/domain`: framework-independent domain types, schemas, policies, and tests.
- `docs`: product, architecture, privacy, and decision records.
