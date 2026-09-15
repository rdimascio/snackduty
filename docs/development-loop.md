# Development and verification loop

Use synthetic local scenarios to implement the coach–parent–player beta. League operations remain R4 and branded apps remain R5. A passing development gate is not production authentication, signing, or TestFlight evidence.

## Start with a reproducible scenario

```sh
bun install --frozen-lockfile
bun run dev:scenario
```

The command starts an isolated local server and temporary database, creates two independent teams through the real APIs, and verifies their permissions before printing connection instructions. The second adult is a parent on both teams and a co-coach on only one. Children are participants without accounts. Browser role-switch instructions use the existing development sign-in and HttpOnly cookies; there are no credentials to copy.

Keep the process running while inspecting the app. Ctrl-C stops the server and removes its temporary data. The regular development database is untouched. To seed, verify, and clean up without keeping a server open:

```sh
bun run check:scenario
```

To build and launch the native app against the same seeded server, use the default available iPhone simulator or select one by its exact name or UDID:

```sh
bun run dev:scenario --ios
bun run dev:scenario --ios="iPhone 16"
```

The harness boots the selected simulator when needed, installs the Debug app, and explicitly supplies its loopback API base URL and `SNACKDAY_DEV_SIGN_IN=true` through the simulator environment. Release builds use the bundled HTTPS configuration and contain no development sign-in operation. Keep the command running for the native session; Ctrl-C removes the temporary server data.

The scenario fixtures and assertions live in `scripts/lib/dev-scenario-seed.ts`. Extend these when adding another reproducible role or journey; avoid maintaining a separate set of manual SQL seeds. This scenario supplements the larger acceptance journey, which exercises imports, invitation lifecycle, events, attendance, calendar feeds, and the native API client.

Scenario startup or verification failures print redacted server-log tails before cleanup. The larger acceptance command preserves complete redacted failure logs as described below.

## Choose the smallest useful check

| During development             | Command                                     | What it proves                                                                                                                |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| One backend feature            | `bun test apps/web/test/duties-api.test.ts` | Focused API regression coverage; substitute the relevant test file                                                            |
| TypeScript and harness changes | `bun run check:fast`                        | Formatting, lint, strict TypeScript, web/domain/platform tests, and harness tests including the real local scenario; no Xcode |
| Native visible behavior        | `bun run ios:test:ui`                       | Launch, roster privacy text, tab navigation, and an attached screenshot using a Debug-only synthetic fixture                  |
| Native models and UI           | `bun run ios:test`                          | Shared-scheme Swift and UI tests, with guards against zero-test success                                                       |
| Real client/server integration | `bun run accept`                            | Disposable live HTTP journey plus native API round trip                                                                       |
| Before merging                 | `bun run gate`                              | All required checks, builds, native UI tests, and live acceptance on macOS                                                    |

The fast CI job reports separately from the full macOS job. Both must pass before merging. Fast checks are a subset of the full gate. The native UI smoke uses a deterministic fixture; the separate live API test proves transport behavior. Neither alone proves the complete coach–parent product journey.

## Use failures as the next run's starting point

Acceptance writes a machine-readable receipt under `.artifacts/acceptance/`. Failure runs retain redacted server and native logs there; temporary databases are removed. CI retains those artifacts and native `.xcresult` bundles. Inspect the failed step and complete logs before rerunning the whole gate. Do not attach real family data, session cookies, invitation credentials, or environment dumps to issues or PRs.

For a confirmed defect:

1. Capture the minimal synthetic scenario and expected behavior.
2. Add a regression that fails for that behavior before applying the fix.
3. Run the focused check while iterating, then the full gate before merging.
4. Record the verification command and evidence in the PR. Update this guide only when the lesson changes how the next agent should work.

Keep agent tasks bounded by files and a concrete observable outcome. Give parallel agents separate ownership, and serialize simulator work against the same DerivedData directory. Independent review should challenge the implementation and its test evidence before publishing.

The Debug-only native fixture depends on `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG` in the app's Debug build configuration. A target named Debug does not define that Swift condition automatically. The UI smoke initially caught this missing setting; keep its named-pass guard when changing schemes or build settings.

## Architectural boundaries to remember

Runtime team authorization loads current database evidence through `apps/web/app/lib/server/authorization.ts` and evaluates `packages/domain/src/policies.ts`. Capability hints never grant access. Preserve owner-only delegation, additive guardian rights, and active team/season boundaries. Exercise actual composed API and page paths as well as policy unit tests.

`lesto.app.ts` exports a per-boot factory; importing it does not open a database. Lesto already supports factory configuration and request-local `Context.set/get`, so application instances need no module-global service registry. The durable Bun runtime uses the same composition, file routes and migration list. See [ADR 0010](./adr/0010-beta-application-foundation.md) and the [staging runbook](./staging-runtime.md).

Native Debug targets explicitly enable both `DEBUG` and testability. URLSession may present request bodies to a test URLProtocol as a stream on the simulator: a fake server that reads only `httpBody` does not reproduce the real transport. Keep the session-generation regressions and run the real simulator checks; static Swift compilation does not prove controller/UI behavior.

The web agent guide documents Lesto's development MCP inspection interface (`describe_app`, diagnostics, and logs). It is development-only and its connection rotates when the server restarts. Refer to `apps/web/AGENTS.md` for connection instructions; do not publish its token in diagnostic artifacts.
