# 0003 — Keep deployment and secrets server-side

- Status: Accepted
- Date: 2026-07-16

## Context

The golden path ends at a live Cloudflare URL. Deployment requires credentials and may create or
change remote resources. Roof is a thin client, Lesto owns deployment behavior, and Studio owns
workflow policy and evidence.

## Decision

- Snackday owns its deployable Lesto application and Cloudflare configuration.
- Lesto owns the deployment command and adapters (`lesto deploy --cloudflare`, Wrangler, and
  Alchemy only where a multi-resource topology requires it).
- Studio owns the attended deployment workflow step, its approval floor, budget, cancellation,
  command evidence, and typed deploy outcome.
- Roof may request an approved operation and display its status and URL. It never receives a
  Cloudflare token or executes deployment logic.
- Cloudflare credentials enter only the server-side run environment. They are never written to the
  board, task messages, model prompts, logs, diffs, notification previews, or client storage.
- Production app mutations remain authorized independently of deployment authority. Same-account
  Worker-to-Worker calls use service bindings rather than public URLs.

During the pilot, deployment, authentication, credential, money, merge, and destructive approvals
remain human-gated.

## Consequences

- Local development and verification require no production credential.
- A deploy outcome must distinguish command completion, health verification, and final gate
  verdict; a URL alone is not success.
- Credential absence is an actionable human blocker, not a reason to weaken the workflow.
