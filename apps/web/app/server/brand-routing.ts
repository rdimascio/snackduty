import { lesto } from "@lesto/web";
import type { HandleOptions, Lesto, LestoResponse, PageDef } from "@lesto/web";

import { brandOfRequest } from "../brand/brand";
import { contentSecurityPolicyFor, withContentSecurityPolicy } from "./content-security-policy";
import { FONT_ROUTE, fontResponse } from "./fonts";

export type RequestHandle = (
  method: string,
  path: string,
  options?: HandleOptions,
) => Promise<LestoResponse>;

export interface BallplayerPages {
  readonly home: PageDef<"/">;
}

const BALLPLAYER_PAGE_PATHS: ReadonlySet<string> = new Set(["/"]);

const FONT_PATH_PREFIX = "/fonts/";

const BALLPLAYER_PLATFORM_PATHS: ReadonlySet<string> = new Set(["/styles.css", "/client.js"]);

const BALLPLAYER_PLATFORM_PREFIXES: readonly string[] = ["/api/", "/__lesto/"];

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const ballplayerNotFound: LestoResponse = {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "Not Found",
};

function isBallplayerRoute(method: string, path: string): boolean {
  return (
    READ_METHODS.has(method.toUpperCase()) &&
    (BALLPLAYER_PAGE_PATHS.has(path) || path.startsWith(FONT_PATH_PREFIX))
  );
}

function isBallplayerPlatformPath(path: string): boolean {
  return (
    BALLPLAYER_PLATFORM_PATHS.has(path) ||
    BALLPLAYER_PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function ballplayerSite(pages: BallplayerPages): Lesto {
  return lesto()
    .styles("/styles.css")
    .page("/", pages.home)
    .get(FONT_ROUTE, (c) => fontResponse(c.param("file")));
}

export function withBrandSecurity(handle: RequestHandle): RequestHandle {
  return async (method, path, options) => {
    const response = await handle(method, path, options);
    return withContentSecurityPolicy(
      response,
      contentSecurityPolicyFor(brandOfRequest(options?.headers)),
    );
  };
}

export function withBrandRoutes(handle: RequestHandle, pages: BallplayerPages): RequestHandle {
  const site = ballplayerSite(pages);
  return async (method, path, options) => {
    if (brandOfRequest(options?.headers) !== "ballplayer") return handle(method, path, options);
    if (isBallplayerRoute(method, path)) return site.handle(method.toUpperCase(), path, options);
    if (isBallplayerPlatformPath(path)) return handle(method, path, options);
    return ballplayerNotFound;
  };
}

const routedApps = new WeakSet<Lesto>();

export function routeBrands(app: Lesto, pages: BallplayerPages): Lesto {
  if (routedApps.has(app)) return app;
  routedApps.add(app);
  app.handle = withBrandRoutes(app.handle.bind(app), pages);
  return app;
}

const securedApps = new WeakSet<Lesto>();

export function secureBrands(app: Lesto): Lesto {
  if (securedApps.has(app)) return app;
  securedApps.add(app);
  app.handle = withBrandSecurity(app.handle.bind(app));
  return app;
}
