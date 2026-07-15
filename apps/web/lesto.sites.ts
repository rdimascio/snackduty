import type { Site } from "@lesto/sites";

/**
 * One dynamic site at the root: every route runs live through the app's handler.
 * Add static zones (`render: "static"` with a `pages` list) or extra origins
 * here as the app grows.
 */
const sites: Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

export default sites;
