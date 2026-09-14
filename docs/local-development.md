# Local development

For a seeded coach–parent scenario and the focused-to-full verification workflow, start with [Development and verification loop](./development-loop.md).

## Web and API

From the repository root:

```sh
bun install
bun run --filter web dev
```

Open:

- Marketing: <http://127.0.0.1:3000/>
- Features: <http://127.0.0.1:3000/features>
- Product shell: <http://127.0.0.1:3000/app>

Import `docs/postman/Snackday Local.postman_collection.json` into Postman for ready-made requests.

### Development identity

The adult development sign-in is disabled by default. Enable it only for the local server:

```sh
SNACKDAY_DEV_SIGN_IN=true bun run --filter web dev
```

In another shell, use a temporary cookie jar for the focused API check:

```sh
COOKIE_JAR="$(mktemp)"
curl -i -c "$COOKIE_JAR" -X POST -H 'Sec-Fetch-Site: same-origin' \
  http://127.0.0.1:3000/api/dev/sign-in
curl -i -b "$COOKIE_JAR" http://127.0.0.1:3000/api/dev/session
TEAM_JSON="$(curl -sS -b "$COOKIE_JAR" -X POST \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"name":"T-Ball Tigers"}' http://127.0.0.1:3000/api/teams)"
TEAM_ID="$(printf '%s' "$TEAM_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
SEASON_JSON="$(curl -sS -b "$COOKIE_JAR" -X POST \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"label":"Spring 2026","startDate":"2026-03-01","endDate":"2026-06-01","timeZone":"America/Los_Angeles"}' \
  "http://127.0.0.1:3000/api/teams/$TEAM_ID/seasons")"
SEASON_ID="$(printf '%s' "$SEASON_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
curl -i -b "$COOKIE_JAR" "http://127.0.0.1:3000/api/teams/$TEAM_ID"
PARTICIPANT_JSON="$(curl -sS -b "$COOKIE_JAR" -X POST \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"displayName":"Casey Kid","birthDate":"2018-04-09"}' \
  "http://127.0.0.1:3000/api/teams/$TEAM_ID/seasons/$SEASON_ID/participants")"
PARTICIPANT_ID="$(printf '%s' "$PARTICIPANT_JSON" | sed -E 's/.*"participantId":"([^"]+)".*/\1/')"
curl -i -b "$COOKIE_JAR" -X POST \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"displayName":"Alex Guardian","relationship":"parent"}' \
  "http://127.0.0.1:3000/api/participants/$PARTICIPANT_ID/guardians"
curl -i -b "$COOKIE_JAR" -X POST \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
  -d '{"displayName":"Bailey Guardian","relationship":"caregiver","permissions":["participant.read"]}' \
  "http://127.0.0.1:3000/api/participants/$PARTICIPANT_ID/guardians"
curl -i -b "$COOKIE_JAR" http://127.0.0.1:3000/api/teams
curl -i -b "$COOKIE_JAR" \
  "http://127.0.0.1:3000/api/teams/$TEAM_ID/seasons/$SEASON_ID/roster"
rm -f "$COOKIE_JAR"
```

This creates or reuses one deterministic adult `Person` and its separate one-to-one `Account`, then authenticates the Account with an `HttpOnly` cookie. It does not use an email or password and does not create a child `Participant` account. The routes return `404` unless the server-only flag is explicitly enabled. Never enable this flag in production. The cookie omits `Secure` solely because this guarded path is intended for local HTTP.

The two final `GET` reads are the authorized read APIs; like every `GET` they need only the session cookie, not `Sec-Fetch-Site` (the origin check covers mutating verbs only). `GET /api/teams` lists the signed-in adult's active teams with their seasons. `GET /api/teams/$TEAM_ID/seasons/$SEASON_ID/roster` returns each active participant's `displayName`. Managers also receive every participant's optional `birthDate`, active guardians (`guardianId`, `displayName`, `relationship`, `permissions`, `status`), and invitation counts. An active team adult receives those private fields only for a child connected to them by an active guardian relationship with `participant.read`; unrelated player entries omit the private fields and retain `guardians: []` for mobile compatibility. A team on which the adult has no active membership, or a season paired with the wrong team, answers `404 {"error":"team not found"}` and never appears in the team list.

The roster steps add a child to the team's season and attach two guardians. The child becomes a `Person` (no email column exists on `people`), a `Participant` referencing that Person, and an active participant membership on the team and season — never an `Account`. Each guardian call creates its own guardian `Person` plus an active guardian relationship (`relationship` is one of `parent`, `guardian`, `caregiver`, `other`; `permissions` defaults to `["participant.read","participant.manage"]`). Repeating an identical display name and relationship pair for the same participant returns `409 {"error":"guardian already attached"}`.

## Local database

Lesto currently uses SQLite locally. Starting the web server creates and migrates:

```text
apps/web/lesto.db
```

Open that file directly in TablePlus using a SQLite connection. Application tables include `people`, `accounts`, `teams`, `seasons`, `participants`, `guardian_relationships`, and membership, invitation, event, attendance, duty, and calendar-feed tables; `schema_migrations`, `lesto_sessions`, and `lesto_rate_limits` are framework tables. The fixed development adult is inserted only after an enabled sign-in.

SQLite is the Milestone 1 source of truth. Household and role persistence will be added incrementally as those product slices are implemented.

## iOS

Install the iOS 18 Simulator runtime in Xcode, then run:

```sh
bun run ios:build
bun run ios:test
```

The scripts automatically use Xcode from `/Applications/Xcode.app` when the command-line tools are selected globally. For a nonstandard installation, set `DEVELOPER_DIR` to that Xcode application's `Contents/Developer` directory.

Alternatively, open `apps/ios/Snackday.xcodeproj`, select the shared Snackday scheme and an available iPhone simulator, then press Run.

To launch the native app with the reusable two-team scenario, run `bun run dev:scenario --ios`. Pass an exact simulator name or UDID when needed, for example `bun run dev:scenario --ios="iPhone 17"`. The harness builds and installs the app, injects its temporary `localhost` API base URL, and cleans up the isolated database when you press Ctrl-C.

## Full product gate

Run the complete pre-merge check on macOS with full Xcode and an iOS 18 Simulator runtime:

```sh
bun run gate
```

The gate checks formatting, lint, types, workspace tests, and builds. Its iOS test step rejects a successful `xcodebuild` invocation that ran zero Swift tests. The final acceptance step boots the real web application against a throwaway SQLite database, drives the product journey over HTTP, and runs the native live-API test against that same server in the Simulator.

Individual web and domain checks can run on Linux, but they are only a subset. A Linux run cannot be called the full gate because it does not execute the native build, nonzero Swift test suite, or Simulator-backed live acceptance.

## Milestone 1 acceptance

```sh
bun run accept
```

`scripts/acceptance.ts` boots the web app on an ephemeral port against a throwaway SQLite database with `SNACKDAY_DEV_SIGN_IN=true`, then drives the full journey over real HTTP: dev sign-in, create team and season, add a child with a birth date, attach two guardians with different relationships, read the team list and roster back through the authorized APIs, and check that `/app` renders the real roster when the session cookie is present (leaking no emails, tokens, or internal identifiers) and the signed-out state without it. It finishes by running the iOS live round trip (`scripts/ios-live-test.sh`, which forwards the base URL to the test runner as `TEST_RUNNER_SNACKDAY_LIVE_API`) against the same server, and fails loudly if that test is skipped instead of run. The server and scratch database are torn down even on failure.

Prerequisites: full Xcode with the iOS 18 Simulator runtime (the same requirement as `bun run ios:test`). `bun run accept` is also the final step of `bun run gate`; it needs a live local server and a Simulator, but it uses only a throwaway database and synthetic test identities.
