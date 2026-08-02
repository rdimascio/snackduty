import { toFetchHandler, withAssets } from "@lesto/cloudflare";
import type { AssetExecutionContext, AssetFetcher } from "@lesto/cloudflare";
import { createElement } from "react";
import type { ComponentProps, ReactNode } from "react";

import { lesto } from "@lesto/web";

import { logAccessLine, redactingLogRequest } from "./app/lib/server/access-log";
import features from "./app/routes/(marketing)/features/page";
import MarketingLayout from "./app/routes/(marketing)/layout";
import home from "./app/routes/(marketing)/page";
import AppLayout from "./app/routes/app/layout";
import overview from "./app/routes/app/page";
import invite from "./app/routes/invite/page";
import RootLayout from "./app/routes/layout";

function PublicHome(): ReactNode {
  return createElement(
    RootLayout,
    null,
    createElement(MarketingLayout, null, createElement(home.component)),
  );
}

function PublicFeatures(): ReactNode {
  return createElement(
    RootLayout,
    null,
    createElement(MarketingLayout, null, createElement(features.component)),
  );
}

// The overview's `load` (spread onto the `.page` registration below) runs at
// the edge too, but the Worker registers no app services — no filesystem SQLite
// — so it resolves to the signed-out state and the page degrades gracefully.
// This wrapper forwards those loaded props into the file-routed component.
function ProductOverview(props: ComponentProps<typeof overview.component>): ReactNode {
  return createElement(
    RootLayout,
    null,
    createElement(AppLayout, null, createElement(overview.component, props)),
  );
}

// The invite landing's `load` runs at the edge too; with no registered app
// services it resolves to the "open this link in the app" state — the invited
// parent gets a calm explanation instead of a 404, and no invitation data is
// ever readable from the DB-less Worker. The token is in the URL fragment, so
// the edge never receives it either way.
function InviteLanding(props: ComponentProps<typeof invite.component>): ReactNode {
  return createElement(RootLayout, null, createElement(invite.component, props));
}

/** The bindings this Worker is configured with (see wrangler.jsonc). */
interface Env {
  readonly ASSETS: AssetFetcher;
}

// The edge entry mounts the SAME file-routed home as `lesto dev`: `home` is the
// `PageDef` default-exported by `app/routes/page.tsx`, wrapped by the `RootLayout`
// from `app/routes/layout.tsx` — so editing those files changes BOTH the dev page
// and the deployed Worker, with no hand-built twin to drift out of sync. A Worker
// has no filesystem to discover routes at request time, so each route is registered
// EXPLICITLY here: add a `.page("/path", def)` for every new file route you want at
// the edge (richer SQLite-backed routes stay server-side — the Worker has no
// filesystem DB). Built ONCE at module scope (per isolate), reused every request.
const app = lesto()
  .client("/client.js")
  // The stylesheet `lesto build` compiled to `out/styles.css` (ADR 0037), served
  // here from `ASSETS` and linked into every page — the edge twin of the dev link.
  .styles("/styles.css")
  .page("/", { ...home, component: PublicHome })
  .page("/features", { ...features, component: PublicFeatures })
  .page("/app", { ...overview, component: ProductOverview })
  .page("/invite", { ...invite, component: InviteLanding });

// The edge access log is the one place this Worker writes a request path. The
// invitation token now travels in the URL FRAGMENT, which no browser sends, so
// no live credential reaches this sink by the current link shape — but the
// default sink logs `url.pathname` verbatim for EVERY admitted request (404s
// included), so it stays replaced by the same structured line with credential
// segments redacted: legacy-shaped `/invite/<token>` hits still arrive from
// already-sent mail and bookmarks, and the next secret-bearing path is one
// line in `access-log.ts` rather than a new incident. Method, status, latency,
// and request id are untouched.
const handler = toFetchHandler((method, path, options) => app.handle(method, path, options), {
  logRequest: redactingLogRequest(logAccessLine),
});

export default {
  fetch(request: Request, env: Env, ctx: AssetExecutionContext): Promise<Response> {
    // Static files from `out/` first (cached at the PoP); the live app for the
    // rest. `env.ASSETS` is per-request, so this thin wrap happens every time; the
    // handler it wraps is the cached, isolate-lifetime one above.
    return withAssets(env.ASSETS, handler)(request, ctx);
  },
};
