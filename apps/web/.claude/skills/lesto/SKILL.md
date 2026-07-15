---
name: lesto
description: Develop and operate this Lesto app — run the dev server, connect to its loopback MCP control plane, add routes/tables/islands, and verify changes. Use whenever working in this repository.
---

# Working on this Lesto app

Layout and conventions live in [AGENTS.md](../../../AGENTS.md); this skill is
the procedure.

## Run it

`bun install` once, then `bun run dev` (serves http://localhost:3000;
`--port N` to move it). The dev output prints one banner line you need:

```
lesto dev: MCP control plane on http://127.0.0.1:<port>/ (x-lesto-dev-token: <token>)
```

## Operate it over MCP (do this before grepping)

1. Register the control plane — port and token rotate on every `lesto dev`
   run, so re-add after a restart:

   ```sh
   claude mcp add --transport http lesto-dev http://127.0.0.1:<port>/ \
     --header "x-lesto-dev-token: <token>"
   ```

2. Call `describe_app` — one round-trip returns the routes, the OpenAPI
   contract, the content collections, and the schema.
3. The session is read-only by default: `list_routes`, `query_content`,
   `get_dev_diagnostics`, `get_recent_requests`, and `tail_logs` all work; a
   destructive tool refusing with `MCP_OPERATOR_REQUIRED` is the governance
   working, not a bug.

## Verify by hand

- Reads are plain: `curl http://localhost:3000/posts`.
- State-changing requests are CSRF-guarded by default: a non-browser client
  must send `Sec-Fetch-Site: same-origin` or it is refused with a 403.

## Add things

- A page: `app/routes/<path>/page.tsx` default-exporting a `PageDef` — the
  file IS the route.
- An API route: chain `.get`/`.post` in `lesto.app.ts`; validate bodies at the
  boundary with `c.valid(Schema)`.
- A table: `defineTable` plus a `MigrationEntry` in `lesto.app.ts`; migrations
  run on the next dev boot.
- An interactive island: `app/islands/<name>.tsx` default-exporting
  `defineIsland`.
- A shadcn component: `npx shadcn add <name>` (this is a generic shadcn project —
  `components.json` routes it into `app/components/ui`).

## Docs / another app

Docs are agent-readable at https://docs.lesto.run (`/llms.txt` is the index;
any page's Markdown twin is its path + `.md`). Scaffold a fresh app with
`bunx create-lesto <name>`.
