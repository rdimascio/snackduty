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
rm -f "$COOKIE_JAR"
```

This creates or reuses one deterministic adult `Person` and its separate one-to-one `Account`, then authenticates the Account with an `HttpOnly` cookie. It does not use an email or password and does not create a child `Participant` account. The routes return `404` unless the server-only flag is explicitly enabled. Never enable this flag in production. The cookie omits `Secure` solely because this guarded path is intended for local HTTP.

## Local database

Lesto currently uses SQLite locally. Starting the web server creates and migrates:

```text
apps/web/lesto.db
```

Open that file directly in TablePlus using a SQLite connection. Application tables are `posts`, `people`, and `accounts`; `schema_migrations`, `lesto_sessions`, and `lesto_rate_limits` are framework tables. The fixed development adult is inserted only after an enabled sign-in.

The remaining Snackday domain schemas are not persistence tables yet. A Docker Postgres service should be introduced with the broader persistence task so it contains the real household, participant, team, role, membership, and guardian schema rather than an empty placeholder database.

## iOS

Install the iOS 18 Simulator runtime in Xcode, then run:

```sh
bun run ios:build
bun run ios:test
```

The scripts automatically use Xcode from `/Applications/Xcode.app` when the command-line tools are selected globally. For a nonstandard installation, set `DEVELOPER_DIR` to that Xcode application's `Contents/Developer` directory.

Alternatively, open `apps/ios/Snackday.xcodeproj`, select the shared Snackday scheme and an available iPhone simulator, then press Run.
