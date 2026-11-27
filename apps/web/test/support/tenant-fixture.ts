import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlDatabase } from "@lesto/db";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";

import { openRuntimeApplication } from "../../runtime";
import type { RuntimeApplication, RuntimeApplicationAdapters } from "../../runtime";

/** The exact headers main serves, copied as literals so a change to the policy builder cannot hide here. */
export const SNACKDAY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://media.dimasciobaseball.com; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const STRICT_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const RUNTIME_HOST = "staging.snackduty.test";

const NOW = "2026-11-25T12:00:00.000Z";

export function withHost(host: string, extra: Record<string, string> = {}): HandleOptions {
  return { headers: { host, ...extra } };
}

export function headerNamed(response: AnyLestoResponse, name: string): string | undefined {
  const value = Object.entries(response.headers).find(
    ([header]) => header.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value.join(", ") : value;
}

export async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

/** The page title and `data-brand` of an HTML body, or the start of any other body. */
export function markerOf(body: string): string {
  const title = /<title>([^<]*)<\/title>/u.exec(body)?.[1];
  if (title === undefined) return body.slice(0, 60);
  const brand = /data-brand="([^"]*)"/u.exec(body)?.[1] ?? "none";
  return `title=${title} brand=${brand}`;
}

export async function addHostname(
  sql: SqlDatabase,
  hostname: string,
  organizationId: string,
): Promise<void> {
  await sql
    .prepare(
      "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, cf_custom_hostname_id, is_primary, created_at, updated_at) VALUES (?, ?, 'custom', 'active', NULL, 0, ?, ?)",
    )
    .run([hostname, organizationId, NOW, NOW]);
}

export async function markHostnamePending(sql: SqlDatabase, hostname: string): Promise<void> {
  await sql
    .prepare("UPDATE organization_hostnames SET status = 'pending' WHERE hostname = ?")
    .run([hostname]);
}

export interface RuntimeFixture {
  readonly runtime: RuntimeApplication;
  close(): Promise<void>;
}

export async function openRuntimeFixture(
  adapters: RuntimeApplicationAdapters = {},
): Promise<RuntimeFixture> {
  const scratch = await mkdtemp(join(tmpdir(), "snackday-tenant-"));
  const runtime = await openRuntimeApplication(
    {
      mode: "staging",
      databasePath: join(scratch, "runtime.db"),
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: new URL(`https://${RUNTIME_HOST}`),
      appleClientId: "com.snackday.runtime-fixture",
      upstreamCredentialPathLoggingSafe: false,
    },
    adapters,
  );
  return {
    runtime,
    close: async () => {
      await runtime.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

/** Counts every statement that reads or writes `organization_hostnames`. */
export function countingHostnameReads(sql: SqlDatabase): {
  readonly sql: SqlDatabase;
  count(): number;
} {
  let reads = 0;
  const counted = new Proxy(sql, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (statement: string) => {
          if (statement.includes("organization_hostnames")) reads += 1;
          return target.prepare(statement);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { sql: counted, count: () => reads };
}
