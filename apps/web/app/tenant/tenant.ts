/**
 * The request tenant: which organization a Host header names, with its modules,
 * theme and primary host. One host-row read (joined to its organization) plus
 * one read for the organization's modules and primary host, then a small
 * per-process cache so most requests touch no table at all.
 */

import { and, eq } from "@lesto/db";
import type { Db } from "@lesto/db";

import { hostName } from "../brand/brand";
import {
  ACTIVE,
  ORGANIZATION_MODULES,
  PRIMARY_HOSTNAME,
  SNACKDAY_ORGANIZATION_ID,
  organizationHostnames,
  organizationModules,
  organizations,
} from "../lib/server/organizations";
import type { OrganizationModule } from "../lib/server/organizations";

export interface Tenant {
  readonly organizationId: string;
  readonly slug: string;
  readonly modules: readonly OrganizationModule[];
  readonly theme: string;
  readonly primaryHost: string | undefined;
}

/**
 * Until the Worker entry answers an unknown host with 404, every host without
 * an active row (staging, CI boot, test and acceptance hosts included) is
 * served as Snackday, exactly as `brand.ts` did before organizations existed.
 */
export const FALLBACK_ORGANIZATION_ID = SNACKDAY_ORGANIZATION_ID;

export const TENANT_CACHE_TTL_MS = 60_000;

/** A host that resolves to nothing is re-read soon, so a new domain goes live quickly. */
export const TENANT_MISS_TTL_MS = 5_000;

export const TENANT_CACHE_MAX_ENTRIES = 1_000;

export interface TenantCacheOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly missTtlMs?: number;
  readonly maxEntries?: number;
}

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

class ExpiringCache<V> {
  readonly #entries = new Map<string, CacheEntry<V>>();
  readonly now: () => number;
  readonly maxEntries: number;

  constructor(now: () => number, maxEntries: number) {
    this.now = now;
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry<V> | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.#entries.delete(key);
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }
}

export class TenantCache {
  readonly hosts: ExpiringCache<Tenant | undefined>;
  readonly organizations: ExpiringCache<Tenant | undefined>;
  readonly ttlMs: number;
  readonly missTtlMs: number;

  constructor(options: TenantCacheOptions = {}) {
    const now = options.now ?? Date.now;
    const maxEntries = options.maxEntries ?? TENANT_CACHE_MAX_ENTRIES;
    this.hosts = new ExpiringCache(now, maxEntries);
    this.organizations = new ExpiringCache(now, maxEntries);
    this.ttlMs = options.ttlMs ?? TENANT_CACHE_TTL_MS;
    this.missTtlMs = options.missTtlMs ?? TENANT_MISS_TTL_MS;
  }

  ttlFor(value: Tenant | undefined): number {
    return value === undefined ? this.missTtlMs : this.ttlMs;
  }
}

const processCaches = new WeakMap<Db, TenantCache>();

function processCacheFor(db: Db): TenantCache {
  let cache = processCaches.get(db);
  if (cache === undefined) {
    cache = new TenantCache();
    processCaches.set(db, cache);
  }
  return cache;
}

function inModuleOrder(modules: readonly string[]): OrganizationModule[] {
  const present: ReadonlySet<string> = new Set(modules);
  return ORGANIZATION_MODULES.filter((module) => present.has(module));
}

interface OrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly theme: string;
}

async function tenantOf(db: Db, organization: OrganizationRow): Promise<Tenant> {
  const [moduleRows, primary] = await Promise.all([
    db
      .select()
      .from(organizationModules)
      .where(eq(organizationModules.organizationId, organization.id))
      .all(),
    db
      .select()
      .from(organizationHostnames)
      .where(
        and(
          eq(organizationHostnames.organizationId, organization.id),
          eq(organizationHostnames.isPrimary, PRIMARY_HOSTNAME),
        ),
      )
      .get(),
  ]);
  return {
    organizationId: organization.id,
    slug: organization.slug,
    modules: inModuleOrder(moduleRows.map((row) => row.module)),
    theme: organization.theme,
    primaryHost: primary?.hostname,
  };
}

async function readHostTenant(db: Db, name: string): Promise<Tenant | undefined> {
  const row = await db
    .select()
    .from(organizationHostnames)
    .innerJoin(organizations, eq(organizationHostnames.organizationId, organizations.id))
    .where(
      and(
        eq(organizationHostnames.hostname, name),
        eq(organizationHostnames.status, ACTIVE),
        eq(organizations.status, ACTIVE),
      ),
    )
    .get();
  if (row === undefined) return undefined;
  return tenantOf(db, row.organizations);
}

async function readOrganizationTenant(db: Db, organizationId: string): Promise<Tenant | undefined> {
  const organization = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.status, ACTIVE)))
    .get();
  if (organization === undefined) return undefined;
  return tenantOf(db, organization);
}

/**
 * The tenant an active hostname row names, or `undefined` when the host has no
 * row, its row is pending, or its organization is archived.
 */
export async function resolveTenant(
  db: Db,
  host: string | undefined,
  cache: TenantCache = processCacheFor(db),
): Promise<Tenant | undefined> {
  const name = hostName(host);
  const cached = cache.hosts.get(name);
  if (cached !== undefined) return cached.value;
  const tenant = name === "" ? undefined : await readHostTenant(db, name);
  cache.hosts.set(name, tenant, cache.ttlFor(tenant));
  return tenant;
}

async function fallbackTenant(db: Db, cache: TenantCache): Promise<Tenant> {
  const cached = cache.organizations.get(FALLBACK_ORGANIZATION_ID);
  const tenant =
    cached === undefined
      ? await readOrganizationTenant(db, FALLBACK_ORGANIZATION_ID)
      : cached.value;
  if (cached === undefined) {
    cache.organizations.set(FALLBACK_ORGANIZATION_ID, tenant, cache.ttlFor(tenant));
  }
  if (tenant === undefined) {
    throw new Error(
      `The fallback organization ${FALLBACK_ORGANIZATION_ID} is missing or archived.`,
    );
  }
  return tenant;
}

/** The tenant for a host, with an unknown host served by the fallback organization. */
export async function tenantForHost(
  db: Db,
  host: string | undefined,
  cache: TenantCache = processCacheFor(db),
): Promise<Tenant> {
  return (await resolveTenant(db, host, cache)) ?? fallbackTenant(db, cache);
}

export type RequestHeaders = Readonly<Record<string, string>>;

export type TenantOfRequest = (headers: RequestHeaders | undefined) => Promise<Tenant>;

/**
 * Resolves each request's tenant from its `Host` header only (never
 * `X-Forwarded-Host`). Wrappers that see the same headers object share one
 * resolution, so the brand router and the CSP wrapper agree on one request.
 */
export function tenantOfRequest(db: Db, cache: TenantCache = processCacheFor(db)): TenantOfRequest {
  const perRequest = new WeakMap<RequestHeaders, Promise<Tenant>>();
  return (headers) => {
    if (headers === undefined) return tenantForHost(db, undefined, cache);
    const known = perRequest.get(headers);
    if (known !== undefined) return known;
    const tenant = tenantForHost(db, headers["host"], cache);
    perRequest.set(headers, tenant);
    return tenant;
  };
}
