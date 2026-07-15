import { toFetchHandler, withAssets } from "@lesto/cloudflare";
import type { AssetExecutionContext, AssetFetcher } from "@lesto/cloudflare";
import { createElement } from "react";
import type { ReactNode } from "react";

import { lesto } from "@lesto/web";

import features from "./app/routes/(marketing)/features/page";
import MarketingLayout from "./app/routes/(marketing)/layout";
import home from "./app/routes/(marketing)/page";
import AppLayout from "./app/routes/app/layout";
import overview from "./app/routes/app/page";
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

function ProductOverview(): ReactNode {
  return createElement(
    RootLayout,
    null,
    createElement(AppLayout, null, createElement(overview.component)),
  );
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
  .page("/app", { ...overview, component: ProductOverview });

const handler = toFetchHandler((method, path, options) => app.handle(method, path, options));

export default {
  fetch(request: Request, env: Env, ctx: AssetExecutionContext): Promise<Response> {
    // Static files from `out/` first (cached at the PoP); the live app for the
    // rest. `env.ASSETS` is per-request, so this thin wrap happens every time; the
    // handler it wraps is the cached, isolate-lifetime one above.
    return withAssets(env.ASSETS, handler)(request, ctx);
  },
};
