import {
  installSessionSchema,
  Sessions,
  sqlSessionStore,
  type Session,
  type SessionStore,
} from "@lesto/auth";
import { createDb, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { z } from "zod";
import type { SessionService } from "./application-contracts";

export const people = defineTable("people", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const accounts = defineTable("accounts", {
  id: text("id").primaryKey(),
  personId: text("person_id")
    .notNull()
    .unique()
    .references(() => people.id),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createIdentity: MigrationEntry = {
  version: "003_create_identity",
  migration: {
    up: (schema) => {
      schema.execute(createTableSql(people));
      schema.execute(createTableSql(accounts));
    },
    down: (schema) => {
      schema.execute(dropTableSql(accounts));
      schema.execute(dropTableSql(people));
    },
  },
};

export const DEV_PERSON_ID = "person_dev_adult";
export const DEV_ACCOUNT_ID = "account_dev_adult";
export const DEV_DISPLAY_NAME = "Development Adult";
export const DEV_SESSION_COOKIE = "snackday_session_dev";
export const VERIFIED_SESSION_COOKIE = "__Host-snackday_session";
export const DEV_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const VERIFIED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * The BOUNDED development persona allowlist. Each persona is a fixed
 * Person+Account fixture that the dev sign-in ensures idempotently; nothing
 * outside this map can ever be minted through `/api/dev/sign-in`, so the
 * endpoint cannot be used to fabricate arbitrary identities. `default` is the
 * original development adult (the no-body sign-in behavior); `second-adult`
 * exists so invitation acceptance is testable end-to-end by a second session.
 */
export const DEV_PERSONA_KEYS = ["default", "second-adult"] as const;
export type DevPersonaKey = (typeof DEV_PERSONA_KEYS)[number];

interface DevPersonaFixture {
  readonly personId: string;
  readonly accountId: string;
  readonly displayName: string;
}

export const DEV_PERSONAS = {
  default: {
    personId: DEV_PERSON_ID,
    accountId: DEV_ACCOUNT_ID,
    displayName: DEV_DISPLAY_NAME,
  },
  "second-adult": {
    personId: "person_dev_second_adult",
    accountId: "account_dev_second_adult",
    displayName: "Second Development Adult",
  },
} as const satisfies Record<DevPersonaKey, DevPersonaFixture>;

const devSignInInputSchema = z.strictObject({
  persona: z.enum(DEV_PERSONA_KEYS).optional(),
});

/**
 * Interpret a dev sign-in request body: no body (or `{}`) selects the default
 * persona; a body may ONLY pick from the bounded allowlist. Anything else —
 * unknown keys, unknown personas, non-objects — returns `undefined` so the
 * route can keep answering the historical generic 400.
 */
export function devPersonaFromBody(body: unknown): DevPersonaKey | undefined {
  if (body === undefined) return "default";

  const parsed = devSignInInputSchema.safeParse(body);
  return parsed.success ? (parsed.data.persona ?? "default") : undefined;
}

export interface AdultIdentity {
  readonly account: { readonly id: string };
  readonly person: { readonly id: string; readonly displayName: string };
}

export type IdentityMode = "development" | "verified";

function namespacedSessionStore(store: SessionStore, namespace: IdentityMode): SessionStore {
  const namespaced = (token: string) => `snackday:${namespace}:v1:${token}`;
  return {
    save(session: Session) {
      return store.save({ ...session, token: namespaced(session.token) });
    },
    async find(token: string) {
      const found = await store.find(namespaced(token));
      return found === undefined ? undefined : { ...found, token };
    },
    delete(token: string) {
      return store.delete(namespaced(token));
    },
  };
}

export async function identityServices(
  handle: SqlDatabase,
  options: { readonly mode: IdentityMode; readonly clock?: () => number },
) {
  await installSessionSchema(handle);
  const store = sqlSessionStore(handle);

  return {
    db: createDb(handle),
    sessions: Object.assign(
      new Sessions({
        store: namespacedSessionStore(store, options.mode),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
      { mode: options.mode },
    ),
  };
}

export function developmentIdentityServices(handle: SqlDatabase) {
  return identityServices(handle, { mode: "development" });
}

export function revokeAllAccountSessions(handle: SqlDatabase, accountId: string): Promise<number> {
  return sqlSessionStore(handle).deleteByUserId(accountId);
}

function personaProjection(fixture: DevPersonaFixture): AdultIdentity {
  return {
    account: { id: fixture.accountId },
    person: { id: fixture.personId, displayName: fixture.displayName },
  };
}

function isFixtureValid(
  fixture: DevPersonaFixture,
  person: { id: string; displayName: string; status: string } | undefined,
  account: { id: string; personId: string; status: string } | undefined,
): boolean {
  return (
    person?.id === fixture.personId &&
    person.displayName === fixture.displayName &&
    person.status === "active" &&
    account?.id === fixture.accountId &&
    account.personId === person.id &&
    account.status === "active"
  );
}

/**
 * Idempotently ensure ONE allowlisted persona's fixed Person+Account pair.
 * Creating is only legal when BOTH rows are absent; a half-present or mutated
 * fixture is refused rather than repaired, exactly like the original
 * single-adult behavior.
 */
export function ensureDevelopmentPersona(db: Db, persona: DevPersonaKey): Promise<AdultIdentity> {
  const fixture = DEV_PERSONAS[persona];

  return db.transaction(async (tx) => {
    const existingPerson = await tx
      .select()
      .from(people)
      .where(eq(people.id, fixture.personId))
      .get();
    const existingAccount = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, fixture.accountId))
      .get();

    if (existingPerson === undefined && existingAccount === undefined) {
      const now = new Date().toISOString();

      await tx
        .insert(people)
        .values({
          id: fixture.personId,
          displayName: fixture.displayName,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await tx
        .insert(accounts)
        .values({
          id: fixture.accountId,
          personId: fixture.personId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return personaProjection(fixture);
    }

    if (!isFixtureValid(fixture, existingPerson, existingAccount)) {
      throw new Error("Development identity is unavailable.");
    }

    return personaProjection(fixture);
  });
}

/**
 * Resolve the session cookie to ANY authenticated adult: an active Account
 * joined to an active Person. The development fixture is no longer
 * special-cased — it is just one Account row like any future real one, so
 * invitation acceptance (and every other authorized route) works for every
 * signed-in adult the same way.
 */
export async function authenticatedAdult(
  db: Db,
  sessions: SessionService,
  cookieHeader: string | undefined,
): Promise<AdultIdentity | undefined> {
  const token = sessionTokenFromCookieHeader(cookieHeader, sessions.mode === "verified");

  if (token === undefined) return undefined;

  const session = await sessions.verify(token);
  if (session === undefined) return undefined;

  const account = await db.select().from(accounts).where(eq(accounts.id, session.userId)).get();
  if (account === undefined || account.status !== "active") return undefined;

  const person = await db.select().from(people).where(eq(people.id, account.personId)).get();
  if (person === undefined || person.status !== "active") return undefined;

  return {
    account: { id: account.id },
    person: { id: person.id, displayName: person.displayName },
  };
}

export function sessionTokenFromCookieHeader(
  cookieHeader: string | undefined,
  secure?: boolean,
): string | undefined {
  const verifiedToken = readCookie(cookieHeader, VERIFIED_SESSION_COOKIE);
  const developmentToken = readCookie(cookieHeader, DEV_SESSION_COOKIE);
  if (
    verifiedToken !== undefined &&
    developmentToken !== undefined &&
    verifiedToken !== developmentToken
  ) {
    return undefined;
  }
  if (secure === true) return verifiedToken;
  if (secure === false) return developmentToken;
  return verifiedToken ?? developmentToken;
}

export function developmentSessionCookie(token: string): string {
  return `${DEV_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEV_SESSION_TTL_MS / 1_000}`;
}

export function verifiedSessionCookie(token: string): string {
  return `${VERIFIED_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VERIFIED_SESSION_TTL_MS / 1_000}`;
}

export function clearedSessionCookie(secure: boolean): string {
  const name = secure ? VERIFIED_SESSION_COOKIE : DEV_SESSION_COOKIE;
  const secureAttribute = secure ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly${secureAttribute}; SameSite=Lax; Max-Age=0`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? undefined : value;
    }
  }

  return undefined;
}
