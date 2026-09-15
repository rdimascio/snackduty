# Coordination integration ledger

Root owns every shared interface and integration file. All four Sol tickets
start at the same frozen foundation commit in isolated branches/worktrees.
No agent edits a sibling's files. Shared contract changes are requested from root.

## Tickets and ownership

### J-A — Server application operations

- Mission: implement the six frozen coordination operations and make HTTP
  handlers call them; preserve existing policy, recurrence and duty semantics.
- Own: web server events.ts, attendance.ts, duties.ts; new
  coordination-operations.ts and coordination-actor.ts; web tests events-api.test.ts,
  attendance-api.test.ts, duties-api.test.ts and new coordination-operations.test.ts.
- Forbidden: all other files, especially contracts, migrations, composition,
  manifests, native files and harness. Root owns migration 013 and registration.
- Dependencies: frozen TypeScript contracts and eventCreationReceipts table.
- Done: real SQL operation and HTTP evidence for atomic creation/retry/conflict,
  exact account identity, owner/co-coach/guardian/member, revocation, team/season
  isolation, first own-child RSVP and one-winner self claim. Server responses
  validate shared schemas. No mocked operation counts as completion.

### J-E — Native transport and state

- Mission: implement SnackdayCoordinationTransport on the existing API client
  and new SnackdayCoordinationController against the frozen protocol.
- Own: SnackdayAPIClient.swift; new SnackdayCoordinationController.swift,
  SnackdayCoordinationAPIClientTests.swift and CoordinationControllerTests.swift.
- Forbidden: contracts, existing authentication controller/tests, views, Xcode,
  manifests, backend and harness. Root registers files and runs simulators.
- Dependencies: frozen Swift contracts and canonical fixtures; real server at
  convergence. Retain create requestId across retries. Do not invent new IDs.
- Done: typed safe failures, authenticated authorized paths, context cancellation,
  stale replies across adult/team/season changes, honest mutation/refresh results,
  and canonical response decoding. Use deterministic controlled-request barriers.

### J-F — Native product journey

- Mission: build ScheduleView(context:controller:), EventDetailView and
  CreateEventView using only the frozen controller interface.
- Own: new ScheduleView.swift, EventDetailView.swift, CreateEventView.swift,
  CoordinationViewTests.swift; SnackdayUITests/SnackdayUISmokeTests.swift and new
  CoordinationUITests.swift. Test-only fixture helper may be added as
  CoordinationFixtureController.swift, entirely within DEBUG.
- Forbidden: AppRootView, AppLaunchView, NativeAppStateView, SnackdayApp,
  transport/controller/contracts, Xcode, backend and harness. Root wires them.
- Dependencies: frozen controller and DTOs. Production uses concrete transport.
- Done: coach creates a single event with optional snack slot, parent sees only
  server-projected response options, records RSVP and claims as self; selected
  season/time zone, loading/empty/error/retry, cancellation, stale context and
  mutation feedback are honest. No live preview fallback. Named UI tests retain
  privacy assertions and screenshots. Root executes simulator tests.

### J-G — Real composed acceptance

- Mission: prove the first coordination journey through the real composed runtime
  using generated, cryptographically verified adult identities and durable SQL.
- Own: apps/web/test/beta-journey.test.ts only.
- Forbidden: all other files, especially application wiring, contracts, migrations,
  scripts, native files and release documents.
- Dependencies: frozen contracts and J-A implementation. This ticket reused the
  J-E Sol slot after transport implementation completed.
- Done: dual coach–parent identity, recipient-bound joining without implicit child
  authority, atomic event/snack replay, own-child RSVP, self claim, independent
  team/season boundaries, revocation and durable restart. Generated keys establish
  local integration only; live provider verification remains incomplete.

### Root — Foundation and convergence

Own all unallocated files, including contracts/fixtures, migration 013, route
composition, Xcode/schemes, app composition, manifests/lockfile, CI and scripts.
Integrate leaves, add real multi-adult acceptance, update evidence/backlog, obtain
full independent review and run all required checks before publishing/merging.
Simulator and shared DerivedData access are serialized by root.

## Receipts

| Owner           | Source commit        | Integrated commit               | Evidence                                                                                                                          |
| --------------- | -------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Root foundation | `82d19b4`            | `82d19b4`                       | Contracts, canonical TS/Swift fixtures, migration 013; 47 native domain tests and 8 migration/runtime tests passed before leaves. |
| J-A Sol         | `ab275ce`            | `7e57cea`                       | 46 focused server tests, 6 co-coach tests and strict type checking passed.                                                        |
| J-E Sol         | `f52bb4b`            | `eacd6c2`                       | Six real transport operations, typed failures and deterministic controller tests; simulator verification owned by root.           |
| J-F Sol         | `373db5f`, `d648c17` | `1a6cb85` plus root integration | Views, fixture UI/model tests; sorting simplification incorporated centrally after an actual Swift compiler timeout.              |
| J-G Sol         | `fe33c40`            | `17ff976`                       | 2 real composed-runtime tests / 128 assertions passed; the same tests fail against the frozen contracts without J-A routes.       |

Root integration and final Mac/release evidence remain pending. Shared app/Xcode
wiring and actual native/server/UI acceptance are root-owned. An independent
gpt-5.5 review found no additional material issues beyond root's pending session
restoration lifetime and stale RSVP schedule count regressions. The requested
additional Claude review hit its account session limit; no Claude coordination
review pass is claimed.
