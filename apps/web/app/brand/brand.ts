import {
  BALLPLAYER_ORGANIZATION_ID,
  COACH_ORGANIZATION_ID,
  SNACKDAY_ORGANIZATION_ID,
} from "../lib/server/organizations";
import { FALLBACK_ORGANIZATION_ID } from "../tenant/tenant";

export type Brand = "snackday" | "ballplayer" | "coach";

export const BALLPLAYER_DEV_HOST = "ballplayer.localhost";

export const COACH_DEV_HOST = "coach.localhost";

/**
 * The seeded hostname rows for callers with no database or no resolved tenant
 * yet (the Worker, a kernel 403 or 429, an asset). `tenant-resolver.test.ts`
 * checks that this map equals the active `organization_hostnames` rows of a
 * freshly migrated database.
 */
export const STATIC_HOST_ORGANIZATIONS: ReadonlyMap<string, string> = new Map([
  ["snackday.app", SNACKDAY_ORGANIZATION_ID],
  ["www.snackday.app", SNACKDAY_ORGANIZATION_ID],
  ["localhost", SNACKDAY_ORGANIZATION_ID],
  ["127.0.0.1", SNACKDAY_ORGANIZATION_ID],
  ["[::1]", SNACKDAY_ORGANIZATION_ID],
  ["dimasciobaseball.com", COACH_ORGANIZATION_ID],
  ["www.dimasciobaseball.com", COACH_ORGANIZATION_ID],
  [COACH_DEV_HOST, COACH_ORGANIZATION_ID],
  ["ballplayer.co", BALLPLAYER_ORGANIZATION_ID],
  ["www.ballplayer.co", BALLPLAYER_ORGANIZATION_ID],
  [BALLPLAYER_DEV_HOST, BALLPLAYER_ORGANIZATION_ID],
]);

const BRAND_BY_ORGANIZATION: ReadonlyMap<string, Brand> = new Map([
  [SNACKDAY_ORGANIZATION_ID, "snackday"],
  [COACH_ORGANIZATION_ID, "coach"],
  [BALLPLAYER_ORGANIZATION_ID, "ballplayer"],
]);

const PORT_SUFFIX = /:\d*$/u;

const TRAILING_DOT = /\.$/u;

export function hostName(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(PORT_SUFFIX, "").replace(TRAILING_DOT, "");
}

/** Any organization without its own brand yet renders as Snackday. */
export function brandForOrganization(organizationId: string): Brand {
  return BRAND_BY_ORGANIZATION.get(organizationId) ?? "snackday";
}

export function brandForHost(host: string | undefined): Brand {
  return brandForOrganization(
    STATIC_HOST_ORGANIZATIONS.get(hostName(host)) ?? FALLBACK_ORGANIZATION_ID,
  );
}

export function brandOfRequest(headers: Readonly<Record<string, string>> | undefined): Brand {
  return brandForHost(headers?.["host"]);
}
