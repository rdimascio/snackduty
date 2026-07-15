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

## Local database

Lesto currently uses SQLite locally. Starting the web server creates and migrates:

```text
apps/web/lesto.db
```

Open that file directly in TablePlus using a SQLite connection. The current application table is `posts`; `schema_migrations`, `lesto_sessions`, and `lesto_rate_limits` are framework tables.

The Snackday domain schemas are not persistence tables yet. A Docker Postgres service should be introduced with the persistence task so it contains the real household, participant, team, role, membership, and guardian schema rather than an empty placeholder database.

## iOS

Install the iOS 18 Simulator runtime in Xcode, then run:

```sh
bun run ios:build
bun run ios:test
```

The scripts automatically use Xcode from `/Applications/Xcode.app` when the command-line tools are selected globally. For a nonstandard installation, set `DEVELOPER_DIR` to that Xcode application's `Contents/Developer` directory.

Alternatively, open `apps/ios/Snackday.xcodeproj`, select the shared Snackday scheme and an available iPhone simulator, then press Run.
