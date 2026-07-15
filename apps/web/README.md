# web

A Lesto app — batteries included.

## Develop

```sh
bun install
bun run dev
```

`lesto dev` loads `lesto.app.ts` (which default-exports the app config) and
boots it: the kernel runs migrations and stands up request dispatch over
the typed `@lesto/db` handle the route handlers query through.

## Try it

With `bun run dev` running, the app serves on http://localhost:3000. The
`posts` table is seeded with a few starter rows on first boot (the
`002_seed_posts` migration in `lesto.app.ts`). Read them from the JSON API:

```sh
curl http://localhost:3000/posts
```

Now create one. State-changing requests are CSRF-guarded by default
(`secure: { originCheck: {} }`), which reads the browser's `Sec-Fetch-Site`
header — a non-browser client like `curl` sends none, so it must set it
explicitly or the request is refused with a 403:

```sh
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -H 'Sec-Fetch-Site: same-origin' \
  -d '{"title":"My first post","body":"Hello from curl."}'
```

A blank `title` or `body` is rejected at the boundary with a 422, never a
crash — that is the Zod `c.valid` check in `lesto.app.ts`. Read the list again
and your new post is there.

## For agents

`AGENTS.md` onboards any coding agent (`CLAUDE.md` defers to it, and a
first-party Claude Code skill ships in `.claude/skills/lesto`). While
`bun run dev` runs, the app also exposes a loopback **MCP control plane** —
see the banner in the dev output and the "Drive the app over MCP" section of
`AGENTS.md`.

## Deploy to Cloudflare

```sh
lesto deploy --cloudflare
```

This prerenders the static site into `out/` and runs `wrangler deploy` —
shipping the Worker (`worker.ts`) and its bound Static Assets in one atomic,
Cloudflare-versioned step. `worker.ts` fronts the app through
`@lesto/cloudflare`'s `toFetchHandler` + `withAssets`, serving the prerendered
files first and the live app second.

A Worker has no filesystem SQLite, so `worker.ts` builds a minimal edge twin
of the home page (the hydrating island) rather than importing `lesto.app.ts`
(which opens a local SQLite handle at module scope). To run the `/posts` data
routes on the edge too, wire a Cloudflare D1 binding (see `wrangler.jsonc` and
the `examples/estate` reference in the Lesto source) and build the full app over
`@lesto/db`'s D1 adapter. Edit `wrangler.jsonc`'s `name` to pick your
`*.workers.dev` subdomain, then:

```sh
wrangler login        # one-time, authenticates wrangler against your account
lesto deploy --cloudflare
```

## Structure

- `lesto.app.ts` — the whole app: a `posts` table (defined via
  `@lesto/db`'s `defineTable`), its migration, and a code-first `lesto()`
  app built through a closure factory, with `.get("/posts")` /
  `.post("/posts")` route handlers.
- The `POST /posts` handler validates the request body at the boundary with
  a Zod schema via `c.valid` — a bad body is a 422, never a crash.
  See `docs/adr/0005-validation-at-the-boundary.md` in the Lesto source.
- Security is on by default, declared via the config's `secure` field: per-client
  rate-limiting comes from the kernel default, and `secure: { originCheck: {} }`
  adds zero-token, header-based CSRF — cross-site state-changing requests are
  refused. Note a non-browser client (e.g. `curl`) sends no `Sec-Fetch-Site`, so
  it is refused too — pass `Sec-Fetch-Site: same-origin` when testing by hand.
