import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "@lesto/kernel";
import { scanRoutes } from "@lesto/router";
import { contentTypeOf, nodeStaticReader, staticCacheControl } from "@lesto/runtime";
import { applyFileRoutes, loadFileRoutes } from "@lesto/web";
import type { Lesto, PageDef } from "@lesto/web";

import { loadCoachArticles } from "../app/coach/articles";
import type { ArticleVisibility, CoachArticlePagesModule } from "../app/coach/articles";
import type { CoachBookingPagesModule, CoachBookingServices } from "../app/coach/booking-pages";

import { routeBrands, withBrandSecurity } from "../app/server/brand-routing";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

interface BallplayerHomeModule {
  readonly ballplayerHome: PageDef<"/">;
}

const REMOTE_ARTICLE_VISIBILITY: ArticleVisibility = "published-only";

interface CoachHomeModule {
  readonly coachHome: PageDef<"/">;
}

/** Use the same file-route discovery and layout composition as the Lesto CLI. */
export async function registerRuntimePages(
  app: Lesto,
  coachBooking?: CoachBookingServices,
): Promise<void> {
  const directory = join(webRoot, "app/routes");
  const files = await scanRoutes(
    async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
    directory,
  );
  const modules = await loadFileRoutes(
    files,
    (kind, segments) => import(join(directory, ...segments, kind)),
  );
  applyFileRoutes(app, files, modules);
  const ballplayerHomePage: BallplayerHomeModule = await import(
    join(webRoot, "app/ballplayer/home-page.tsx")
  );
  const coachHomePage: CoachHomeModule = await import(join(webRoot, "app/coach/home-page.tsx"));
  const coachBookPage: CoachBookingPagesModule = await import(
    join(webRoot, "app/coach/book-page.tsx")
  );
  const coachArticlePage: CoachArticlePagesModule = await import(
    join(webRoot, "app/coach/article-pages.tsx")
  );
  const articleLibrary = loadCoachArticles(REMOTE_ARTICLE_VISIBILITY);
  routeBrands(
    app,
    {
      ballplayerHome: ballplayerHomePage.ballplayerHome,
      coachHome: coachHomePage.coachHome,
      coachArticles: {
        library: articleLibrary,
        pages: coachArticlePage.coachArticlePages(articleLibrary),
      },
    },
    coachBooking === undefined
      ? undefined
      : { ...coachBooking, pages: coachBookPage.coachBookingPages },
  );
}

/** Only the two public build outputs are exposed; database/source files never are. */
export function withRuntimeAssets(app: App, outputRoot = join(webRoot, "out")): App {
  const read = nodeStaticReader(outputRoot);
  return {
    ...app,
    async handle(method, path, options) {
      if (
        (method === "GET" || method === "HEAD") &&
        (path === "/client.js" || path === "/styles.css")
      ) {
        const file = path.slice(1);
        const body = await read(file);
        if (typeof body !== "string") return { status: 404, headers: {}, body: "" };
        return {
          status: 200,
          headers: {
            "Content-Type": contentTypeOf(file),
            "Cache-Control": staticCacheControl(file),
            "X-Content-Type-Options": "nosniff",
          },
          body: method === "HEAD" ? "" : body,
        };
      }
      return app.handle(method, path, options);
    },
  };
}

export function withBrandPolicy(app: App): App {
  return { ...app, handle: withBrandSecurity(app.handle.bind(app)) };
}
