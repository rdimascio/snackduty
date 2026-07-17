# 0008 — Platform identity, entitlements, and credentials

- Status: Proposed
- Date: 2026-07-16
- Decider: Chief Architect

## Context

The platform crosses client licensing, orchestration authority, git hosting, deployment providers,
and deployed application identity. Treating one token or user string as all of these authorities
would make audit and revocation unreliable.

## Proposed decision

Maintain separate principals and credentials for:

- Roof seat entitlement;
- Studio human and machine orchestration principals;
- repository/Git provider access;
- Cloudflare deployment access;
- deployed application accounts and sessions.

Studio stamps authoritative actors on approvals, merge authorization, budget decisions, and
deployment requests. Roof stores only its entitlement/session and Studio connection material in the
Keychain. Repository and deployment credentials remain server-side and never enter UI state,
prompts, task messages, logs, notification previews, or release manifests.

## Evidence required

Produce a threat model and token-flow probe for local, hosted, and hybrid modes, including rotation,
revocation, offline launch, device loss, seat removal, machine-principal separation, and an
attempted credential leak through command evidence.
