# Local development

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
- Scaffold API: <http://127.0.0.1:3000/posts>

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
rm -f "$COOKIE_JAR"
```

This creates or reuses one deterministic adult `Person` and its separate one-to-one `Account`, then authenticates the Account with an `HttpOnly` cookie. It does not use an email or password and does not create a child `Participant` account. The routes return `404` unless the server-only flag is explicitly enabled. Never enable this flag in production. The cookie omits `Secure` solely because this guarded path is intended for local HTTP.

The roster steps add a child to the team's season and attach two guardians. The child becomes a `Person` (no email column exists on `people`), a `Participant` referencing that Person, and an active participant membership on the team and season — never an `Account`. Each guardian call creates its own guardian `Person` plus an active guardian relationship (`relationship` is one of `parent`, `guardian`, `caregiver`, `other`; `permissions` defaults to `["participant.read","participant.manage"]`). Repeating an identical display name and relationship pair for the same participant returns `409 {"error":"guardian already attached"}`.

## Local database

Lesto currently uses SQLite locally. Starting the web server creates and migrates:

```text
apps/web/lesto.db
```

Open that file directly in TablePlus using a SQLite connection. Application tables are `posts`, `people`, `accounts`, `teams`, `seasons`, `participants`, `guardian_relationships`, and `memberships`; `schema_migrations`, `lesto_sessions`, and `lesto_rate_limits` are framework tables. The fixed development adult is inserted only after an enabled sign-in.

SQLite is the Milestone 1 source of truth. Household and role persistence will be added incrementally as those product slices are implemented.

## iOS

Install the iOS 18 Simulator runtime in Xcode, then run:

```sh
bun run ios:build
bun run ios:test
```

The scripts automatically use Xcode from `/Applications/Xcode.app` when the command-line tools are selected globally. For a nonstandard installation, set `DEVELOPER_DIR` to that Xcode application's `Contents/Developer` directory.

Alternatively, open `apps/ios/Snackday.xcodeproj`, select the shared Snackday scheme and an available iPhone simulator, then press Run.
