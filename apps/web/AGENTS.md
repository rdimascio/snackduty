# web — agent guide

This is a [Lesto](https://lesto.run) app. Lesto is a batteries-included fullstack
TypeScript framework (ESM, run directly — no build step for the source).

## Commands

- `bun run dev` — start the dev server (`lesto dev`). Boots the app, runs
  migrations, and serves request dispatch.
- `bun run build` — build the client bundle and prerender (`lesto build`).
- `lesto deploy --cloudflare` — prerender to `out/` and `wrangler deploy` the
  Worker (`worker.ts`).

## Drive the app over MCP (the agent control plane)

`lesto dev` also boots a Model Context Protocol server for THIS app, so an
agent can operate the running app instead of only editing files. On boot, the
dev output prints one line:

```
lesto dev: MCP control plane on http://127.0.0.1:<port>/ (x-lesto-dev-token: <token>)
```

- Streamable-HTTP MCP endpoint at that root URL. Loopback-only and dev-only
  (`lesto build` output has no control plane). The port is ephemeral and the
  token rotates on every `lesto dev` run — re-read the banner after a restart.
- Every request must carry the banner's `x-lesto-dev-token` header (403 without).
- The session is **read-only by default**: inspection tools (`describe_app`,
  `list_routes`, `query_content`, `get_dev_diagnostics`, `tail_logs`, ...)
  work; destructive tools refuse with `MCP_OPERATOR_REQUIRED` — that is the
  governance working, not a bug. Enumerate the full set with `tools/list`.
- Call `describe_app` first: one round-trip returns the routes, the OpenAPI
  contract, the content collections, and the schema — prefer it over grepping.

Claude Code (values from the banner; re-add after each dev restart):

```sh
claude mcp add --transport http lesto-dev http://127.0.0.1:<port>/ \
  --header "x-lesto-dev-token: <token>"
```

Any MCP client — or raw JSON-RPC — works the same way:

```sh
curl -s http://127.0.0.1:<port>/ \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-lesto-dev-token: <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"describe_app","arguments":{}}}'
```

## Layout

- `lesto.app.ts` — the app: tables (`@lesto/db`), migrations, and a code-first
  `lesto()` app with `.get`/`.post` API routes. The DB handle is opened here.
- `env.ts` — the typed, validated environment (`@lesto/env`), split `server` /
  `client`. `defineEnv` checks it at boot; read values off `env` (e.g.
  `env.LESTO_DB`), not `process.env`. Server vars never reach the browser (reading
  one in an island throws `ENV_SERVER_LEAK`); `client` vars are `PUBLIC_*` and an
  island reads them via `@lesto/env/client`.
- `app/routes/` — **file-based routing** (ADR 0023). A `page.tsx` makes its
  directory's URL a route; `layout.tsx` wraps every page at or below it. A
  `[param]` directory is a dynamic segment, `[...rest]` a catch-all. Drop a file
  to add a route — no manual registration.
- `app/islands/` — client-interactive components (`defineIsland`), one default
  export per file. The build bundles these into `/client.js`; the rest of the page
  is server-rendered.
- `app/styles/app.css` — the **Tailwind v4** entry (`ui.css` in `lesto.app.ts`).
  `lesto build`/`dev` compile it to `out/styles.css` and link it on every page.
  Tailwind scans `app/` as PLAIN TEXT, so write complete static class strings (not
  `bg-${x}`); see the comment in that file.
- `lesto.sites.ts` — the declared sites (dynamic/static zones).
- `worker.ts` + `wrangler.jsonc` — the Cloudflare edge deploy.

## Conventions

- **TypeScript + ESM.** Source runs directly; `type: "module"`.
- **Validation at the boundary.** Untrusted input (request bodies) is validated
  with a Zod schema via `c.valid(Schema)` before it is trusted — never deeper.
- **Security on by default.** `secure: { originCheck: {} }` in `lesto.app.ts`
  adds header-based CSRF; per-client rate-limiting is on by the kernel default.
- **Pages infer their props.** Author a top-level `const load = ...` and type the
  component with `PageProps<typeof load>` — declare the shape once.
- **Islands hydrate on the client.** A component is interactive only if it is a
  `defineIsland` under `app/islands/`; everything else is server-only.

## Adding things

- A page: `app/routes/<path>/page.tsx` (default-export a `PageDef`).
- An API route: chain `.get(path, handler)` / `.post(...)` in `lesto.app.ts`.
- A table: `defineTable(...)` in `lesto.app.ts` plus a `MigrationEntry`.
- An interactive widget: `app/islands/<name>.tsx` (default-export `defineIsland`).

## Docs

https://docs.lesto.run — written to be agent-readable: `/llms.txt` is the
index, `/llms-full.txt` is the whole corpus in one file, and every page has a
clean-Markdown twin at its path + `.md` (e.g. `/quickstart.md`).
