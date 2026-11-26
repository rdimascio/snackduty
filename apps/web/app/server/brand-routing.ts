import { createElement } from "react";

import { lesto } from "@lesto/web";
import type {
  AnyLestoResponse,
  Context,
  HandleOptions,
  Lesto,
  LestoResponse,
  PageDef,
} from "@lesto/web";

import { BALLPLAYER_APP_PAGE_PATH } from "../ballplayer/app-data";
import type { BallplayerAppModule, BallplayerAppPage } from "../ballplayer/app-data";
import { brandForTenant, brandOfRequest } from "../brand/brand";
import type { Brand } from "../brand/brand";
import { COACH_ARTICLE_PATH, COACH_ARTICLES_PATH } from "../coach/articles";
import type { CoachArticles } from "../coach/articles";
import { readBookingForm } from "../coach/booking-form";
import type { CoachBooking } from "../coach/booking-pages";
import { COACH_BOOK_PATH, COACH_BOOK_RETRY_PATH, COACH_BOOK_SENT_PATH } from "../coach/content";
import type { LessonRequestOperations } from "../coach/lesson-requests";
import {
  COACH_ROBOTS_PATH,
  COACH_SITEMAP_PATH,
  coachRobotsResponse,
  coachSitemapResponse,
} from "../coach/sitemap";
import { contentSecurityPolicyFor, withContentSecurityPolicy } from "./content-security-policy";
import { FONT_ROUTE, fontResponse } from "./fonts";
import type { RequestHeaders, TenantOfRequest } from "../tenant/tenant";

export type RequestHandle = (
  method: string,
  path: string,
  options?: HandleOptions,
) => Promise<LestoResponse>;

export interface BrandPages {
  readonly ballplayerHome: PageDef<"/">;
  readonly coachHome: PageDef<"/">;
  /** Without it the article, sitemap and robots paths are a 404 on the coach host. */
  readonly coachArticles?: CoachArticles;
}

const BALLPLAYER_PAGE_PATHS: ReadonlySet<string> = new Set(["/"]);

const COACH_PAGE_PATHS: ReadonlySet<string> = new Set(["/"]);

const COACH_BOOKING_PAGE_PATHS: ReadonlySet<string> = new Set([
  COACH_BOOK_PATH,
  COACH_BOOK_SENT_PATH,
]);

const COACH_BOOKING_FORM_PATHS: ReadonlySet<string> = new Set([COACH_BOOK_PATH]);

const COACH_ARTICLE_PAGE_PATHS: ReadonlySet<string> = new Set([
  COACH_ARTICLES_PATH,
  COACH_SITEMAP_PATH,
  COACH_ROBOTS_PATH,
]);

const FORM_METHOD = "POST";

const SEE_OTHER = 303;

const FONT_PATH_PREFIX = "/fonts/";

const BALLPLAYER_APP_PATH = "/app";

const BALLPLAYER_INTERNAL_PREFIX = "/__ballplayer/";

const PLATFORM_PATHS: ReadonlySet<string> = new Set(["/styles.css", "/client.js"]);

const PLATFORM_PREFIXES: readonly string[] = ["/api/", "/__lesto/"];

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const notFound: LestoResponse = {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "Not Found",
};

const CACHE_CONTROL_HEADER = "cache-control";

const PRIVATE_NO_STORE = "private, no-store";

function withPrivateNoStore<R extends AnyLestoResponse>(response: R): R {
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

function isCoachArticleRoute(path: string, articles: CoachArticles | undefined): boolean {
  if (articles === undefined) return false;
  return COACH_ARTICLE_PAGE_PATHS.has(path) || articles.library.findByPath(path) !== undefined;
}

function isCoachRoute(
  method: string,
  path: string,
  bookingOpen: boolean,
  articles: CoachArticles | undefined,
): boolean {
  const upper = method.toUpperCase();
  if (READ_METHODS.has(upper)) {
    return (
      COACH_PAGE_PATHS.has(path) ||
      path.startsWith(FONT_PATH_PREFIX) ||
      (bookingOpen && COACH_BOOKING_PAGE_PATHS.has(path)) ||
      isCoachArticleRoute(path, articles)
    );
  }
  return bookingOpen && upper === FORM_METHOD && COACH_BOOKING_FORM_PATHS.has(path);
}

function isBallplayerAppRoute(method: string, path: string): boolean {
  return READ_METHODS.has(method.toUpperCase()) && path === BALLPLAYER_APP_PATH;
}

function isBallplayerInternalPath(path: string): boolean {
  return path.startsWith(BALLPLAYER_INTERNAL_PREFIX);
}

function isPlatformPath(path: string): boolean {
  return PLATFORM_PATHS.has(path) || PLATFORM_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function brandSite(home: PageDef<"/">): Lesto {
  return lesto()
    .styles("/styles.css")
    .page("/", home)
    .get(FONT_ROUTE, (c) => fontResponse(c.param("file")));
}

async function submitLessonRequest(
  c: Context,
  site: Lesto,
  requests: LessonRequestOperations,
): Promise<AnyLestoResponse> {
  const submission = readBookingForm(c.req.body);
  if (submission.kind === "invalid") {
    return withPrivateNoStore(
      await site.handle("GET", COACH_BOOK_RETRY_PATH, {
        headers: c.req.headers,
        body: c.req.body,
      }),
    );
  }
  if (submission.kind === "valid") await requests.record(submission.request);
  return withPrivateNoStore(c.redirect(COACH_BOOK_SENT_PATH, SEE_OTHER));
}

function withCoachArticles(
  site: Lesto,
  articles: CoachArticles | undefined,
  bookingOpen: boolean,
): Lesto {
  if (articles === undefined) return site;
  return site
    .page(COACH_ARTICLES_PATH, articles.pages.list)
    .page(COACH_ARTICLE_PATH, articles.pages.article)
    .get(COACH_SITEMAP_PATH, () => coachSitemapResponse(articles.library, bookingOpen))
    .get(COACH_ROBOTS_PATH, () => coachRobotsResponse());
}

function coachSite(
  home: PageDef<"/">,
  booking: CoachBooking | undefined,
  articles: CoachArticles | undefined,
): Lesto {
  const site = withCoachArticles(brandSite(home), articles, booking !== undefined);
  if (booking === undefined) return site;
  return site
    .page(COACH_BOOK_PATH, booking.pages.book)
    .page(COACH_BOOK_SENT_PATH, booking.pages.bookSent)
    .page(COACH_BOOK_RETRY_PATH, booking.pages.bookRetry)
    .post(COACH_BOOK_PATH, booking.postLimit, (c) =>
      submitLessonRequest(c, site, booking.requests),
    );
}

/**
 * With a resolver the brand comes from the request's tenant row; without one
 * (tests and callers with no database) it comes from `brandOfRequest`.
 */
async function requestBrand(
  headers: RequestHeaders | undefined,
  tenants: TenantOfRequest | undefined,
): Promise<Brand> {
  if (tenants === undefined) return brandOfRequest(headers);
  return brandForTenant(await tenants(headers));
}

export function withBrandSecurity(handle: RequestHandle, tenants?: TenantOfRequest): RequestHandle {
  return async (method, path, options) => {
    const brand = await requestBrand(options?.headers, tenants);
    const response = await handle(method, path, options);
    return withContentSecurityPolicy(response, contentSecurityPolicyFor(brand));
  };
}

export function withBrandRoutes(
  handle: RequestHandle,
  pages: BrandPages,
  coachBooking?: CoachBooking,
  tenants?: TenantOfRequest,
): RequestHandle {
  const ballplayer = brandSite(pages.ballplayerHome);
  const coach = coachSite(pages.coachHome, coachBooking, pages.coachArticles);
  const bookingOpen = coachBooking !== undefined;
  return async (method, path, options) => {
    if (isBallplayerInternalPath(path)) return notFound;
    const brand = await requestBrand(options?.headers, tenants);
    if (brand === "snackday") return handle(method, path, options);
    if (brand === "coach") {
      if (isCoachRoute(method, path, bookingOpen, pages.coachArticles))
        return coach.handle(method.toUpperCase(), path, options);
      if (isPlatformPath(path)) return handle(method, path, options);
      return notFound;
    }
    if (isBallplayerRoute(method, path)) {
      return ballplayer.handle(method.toUpperCase(), path, options);
    }
    if (isBallplayerAppRoute(method, path)) {
      return withPrivateNoStore(await handle(method, BALLPLAYER_APP_PAGE_PATH, options));
    }
    if (isPlatformPath(path)) return handle(method, path, options);
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

export function routeBrands(
  app: Lesto,
  pages: BrandPages,
  coachBooking?: CoachBooking,
  tenants?: TenantOfRequest,
): Lesto {
  if (routedApps.has(app)) return app;
  routedApps.add(app);
  app.page(BALLPLAYER_APP_PAGE_PATH, ballplayerAppPage);
  app.handle = withBrandRoutes(app.handle.bind(app), pages, coachBooking, tenants);
  return app;
}

const securedApps = new WeakSet<Lesto>();

export function secureBrands(app: Lesto, tenants?: TenantOfRequest): Lesto {
  if (securedApps.has(app)) return app;
  securedApps.add(app);
  app.handle = withBrandSecurity(app.handle.bind(app), tenants);
  return app;
}
