import { createElement } from "react";

import { lesto } from "@lesto/web";
import type { HandleOptions, Lesto, LestoResponse, PageDef } from "@lesto/web";

import { BALLPLAYER_APP_PAGE_PATH } from "../ballplayer/app-data";
import type { BallplayerAppModule, BallplayerAppPage } from "../ballplayer/app-data";
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

const BALLPLAYER_APP_PATH = "/app";

const BALLPLAYER_INTERNAL_PREFIX = "/__ballplayer/";

const BALLPLAYER_PLATFORM_PATHS: ReadonlySet<string> = new Set(["/styles.css", "/client.js"]);

const BALLPLAYER_PLATFORM_PREFIXES: readonly string[] = ["/api/", "/__lesto/"];

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const notFound: LestoResponse = {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "Not Found",
};

const CACHE_CONTROL_HEADER = "cache-control";

const PRIVATE_NO_STORE = "private, no-store";

function withPrivateNoStore(response: LestoResponse): LestoResponse {
  const headers: LestoResponse["headers"] = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() !== CACHE_CONTROL_HEADER) headers[name] = value;
  }
  headers[CACHE_CONTROL_HEADER] = PRIVATE_NO_STORE;
  return { ...response, headers };
}

function isBallplayerRoute(method: string, path: string): boolean {
  return (
    READ_METHODS.has(method.toUpperCase()) &&
    (BALLPLAYER_PAGE_PATHS.has(path) || path.startsWith(FONT_PATH_PREFIX))
  );
}

function isBallplayerAppRoute(method: string, path: string): boolean {
  return READ_METHODS.has(method.toUpperCase()) && path === BALLPLAYER_APP_PATH;
}

function isBallplayerInternalPath(path: string): boolean {
  return path.startsWith(BALLPLAYER_INTERNAL_PREFIX);
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
    if (isBallplayerInternalPath(path)) return notFound;
    if (brandOfRequest(options?.headers) !== "ballplayer") return handle(method, path, options);
    if (isBallplayerRoute(method, path)) return site.handle(method.toUpperCase(), path, options);
    if (isBallplayerAppRoute(method, path)) {
      return withPrivateNoStore(await handle(method, BALLPLAYER_APP_PAGE_PATH, options));
    }
    if (isBallplayerPlatformPath(path)) return handle(method, path, options);
    return notFound;
  };
}

const BALLPLAYER_APP_MODULE = new URL("../ballplayer/app-page.tsx", import.meta.url).href;

let ballplayerAppModule: Promise<BallplayerAppModule> | undefined;

function loadBallplayerApp(): Promise<BallplayerAppModule> {
  ballplayerAppModule ??= import(BALLPLAYER_APP_MODULE) as Promise<BallplayerAppModule>;
  return ballplayerAppModule;
}

let loadedBallplayerApp: BallplayerAppPage | undefined;

function loadedPage(): BallplayerAppPage {
  if (loadedBallplayerApp === undefined) throw new Error("Ballplayer app page is not loaded.");
  return loadedBallplayerApp;
}

const ballplayerAppPage: BallplayerAppPage = {
  component: (data) => createElement(loadedPage().component, data),
  load: async (c, search) => {
    loadedBallplayerApp = (await loadBallplayerApp()).ballplayerApp;
    const load = loadedBallplayerApp.load;
    if (load === undefined) throw new Error("Ballplayer app page has no loader.");
    return load(c, search);
  },
  metadata: (data) => loadedPage().metadata?.(data) ?? {},
};

const routedApps = new WeakSet<Lesto>();

export function routeBrands(app: Lesto, pages: BallplayerPages): Lesto {
  if (routedApps.has(app)) return app;
  routedApps.add(app);
  app.page(BALLPLAYER_APP_PAGE_PATH, ballplayerAppPage);
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
