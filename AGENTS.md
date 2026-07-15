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

## Repository layout

- `apps/web`: one Lesto origin for the marketing site and signed-in product.
- `apps/ios`: native SwiftUI application and Xcode project (planned).
- `packages/domain`: framework-independent domain types, schemas, policies, and tests.
- `docs`: product, architecture, privacy, and decision records.
