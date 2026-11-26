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

/** `hostName` trims whitespace, so no host's cache key can start with a space. */
const FALLBACK_CACHE_KEY = " fallback organization";

export const TENANT_CACHE_TTL_MS = 60_000;

/** A host that resolves to nothing is re-read soon, so a new domain goes live quickly. */
export const TENANT_MISS_TTL_MS = 5_000;

export const TENANT_CACHE_MAX_ENTRIES = 1_000;

export interface TenantCacheOptions {
  readonly now?: () => number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly value: Tenant | undefined;
  readonly expiresAt: number;
}

/** One bounded map with expiry. An expired entry stays readable through `peek` until it is replaced. */
export class TenantCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: TenantCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? TENANT_CACHE_MAX_ENTRIES;
  }

  fresh(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    return entry !== undefined && entry.expiresAt > this.#now() ? entry : undefined;
  }

  peek(key: string): CacheEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: Tenant | undefined): void {
    this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    const ttl = value === undefined ? TENANT_MISS_TTL_MS : TENANT_CACHE_TTL_MS;
    this.#entries.set(key, { value, expiresAt: this.#now() + ttl });
  }

  get size(): number {
    return this.#entries.size;
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

async function readFallbackTenant(db: Db): Promise<Tenant | undefined> {
  const organization = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, FALLBACK_ORGANIZATION_ID), eq(organizations.status, ACTIVE)))
    .get();
  if (organization === undefined) return undefined;
  return tenantOf(db, organization);
}

async function readThrough(
  cache: TenantCache,
  key: string,
  read: () => Promise<Tenant | undefined>,
): Promise<Tenant | undefined> {
  const cached = cache.fresh(key);
  if (cached !== undefined) return cached.value;
  const value = await read();
  cache.set(key, value);
  return value;
}

/**
 * The tenant an active hostname row names, or `undefined` when the host has no
 * row, its row is pending, or its organization is archived.
 */
export function resolveTenant(
  db: Db,
  host: string | undefined,
  cache: TenantCache = processCacheFor(db),
): Promise<Tenant | undefined> {
  const name = hostName(host);
  return readThrough(cache, name, async () =>
    name === "" ? undefined : await readHostTenant(db, name),
  );
}

async function fallbackTenant(db: Db, cache: TenantCache): Promise<Tenant> {
  const tenant = await readThrough(cache, FALLBACK_CACHE_KEY, () => readFallbackTenant(db));
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

/** The last tenant resolved for a host, or `undefined` when it has not been resolved. Never reads. */
export function peekTenant(host: string | undefined, cache: TenantCache): Tenant | undefined {
  const entry = cache.peek(hostName(host));
  if (entry === undefined) return undefined;
  return entry.value ?? cache.peek(FALLBACK_CACHE_KEY)?.value;
}

export type RequestHeaders = Readonly<Record<string, string>>;

/** Reads the `Host` header only, never `X-Forwarded-Host`. */
export interface TenantResolver {
  /** Reads through the cache. Call it only behind the kernel's rate limit and origin check. */
  resolve(headers: RequestHeaders | undefined): Promise<Tenant>;
  /** What `resolve` last answered for this host. Never reads. */
  peek(headers: RequestHeaders | undefined): Tenant | undefined;
}

export function tenantResolver(db: Db, cache: TenantCache = processCacheFor(db)): TenantResolver {
  return {
    resolve: (headers) => tenantForHost(db, headers?.["host"], cache),
    peek: (headers) => peekTenant(headers?.["host"], cache),
  };
}
