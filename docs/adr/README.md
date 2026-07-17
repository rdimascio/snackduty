# Architecture decisions

Snackday is the proof application for the agent-operated application platform described in
Lesto's `docs/NORTH-STAR.md`. These records pin the cross-repository boundaries needed to build
and demonstrate that proof without moving product code into the orchestration layer.

- [0001 — Keep product and control-plane repositories separate](0001-repository-and-product-boundaries.md)
- [0002 — Integrate through durable contracts](0002-cross-repository-integration-contract.md)
- [0003 — Keep deployment and secrets server-side](0003-deployment-and-secret-boundary.md)
- [0004 — Require an evidence-backed golden path](0004-golden-path-acceptance-and-evidence.md)
- [0005 — Platform repository topology](0005-platform-repository-topology.md) _(accepted (amended) 2026-07-17)_
- [0006 — Platform packaging and runtime topology](0006-platform-packaging-and-runtime-topology.md) _(accepted (amended) 2026-07-17; D1 launch-ownership open)_
- [0007 — Platform contracts and release manifest](0007-platform-contracts-and-release-manifest.md) _(accepted (amended) 2026-07-17)_
- [0008 — Platform identity, entitlements, and credentials](0008-platform-identity-entitlements-and-credentials.md) _(accepted (amended) 2026-07-17)_
