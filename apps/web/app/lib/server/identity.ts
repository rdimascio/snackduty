import { installSessionSchema, Sessions, sqlSessionStore } from "@lesto/auth";
import { createDb, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

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
export const DEV_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AdultIdentity {
  readonly account: { readonly id: string };
  readonly person: { readonly id: string; readonly displayName: string };
}

export async function developmentIdentityServices(handle: SqlDatabase) {
  await installSessionSchema(handle);

  return {
    db: createDb(handle),
    sessions: new Sessions({ store: sqlSessionStore(handle) }),
  };
}

function projection(): AdultIdentity {
  return {
    account: { id: DEV_ACCOUNT_ID },
    person: { id: DEV_PERSON_ID, displayName: DEV_DISPLAY_NAME },
  };
}

function isFixtureValid(
  person: { id: string; displayName: string; status: string } | undefined,
  account: { id: string; personId: string; status: string } | undefined,
): boolean {
  return (
    person?.id === DEV_PERSON_ID &&
    person.displayName === DEV_DISPLAY_NAME &&
    person.status === "active" &&
    account?.id === DEV_ACCOUNT_ID &&
    account.personId === person.id &&
    account.status === "active"
  );
}

export function ensureDevelopmentAdult(db: Db): Promise<AdultIdentity> {
  return db.transaction(async (tx) => {
    const existingPerson = await tx.select().from(people).where(eq(people.id, DEV_PERSON_ID)).get();
    const existingAccount = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, DEV_ACCOUNT_ID))
      .get();

    if (existingPerson === undefined && existingAccount === undefined) {
      const now = new Date().toISOString();

      await tx
        .insert(people)
        .values({
          id: DEV_PERSON_ID,
          displayName: DEV_DISPLAY_NAME,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await tx
        .insert(accounts)
        .values({
          id: DEV_ACCOUNT_ID,
          personId: DEV_PERSON_ID,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return projection();
    }

    if (!isFixtureValid(existingPerson, existingAccount)) {
      throw new Error("Development identity is unavailable.");
    }

    return projection();
  });
}

export async function authenticatedAdult(
  db: Db,
  sessions: Sessions,
  cookieHeader: string | undefined,
): Promise<AdultIdentity | undefined> {
  const token = readCookie(cookieHeader, DEV_SESSION_COOKIE);

  if (token === undefined) return undefined;

  const session = await sessions.verify(token);

  if (session?.userId !== DEV_ACCOUNT_ID) return undefined;

  const account = await db.select().from(accounts).where(eq(accounts.id, session.userId)).get();
  if (account === undefined) return undefined;

  const person = await db.select().from(people).where(eq(people.id, account.personId)).get();

  return isFixtureValid(person, account) ? projection() : undefined;
}

export function developmentSessionCookie(token: string): string {
  return `${DEV_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEV_SESSION_TTL_MS / 1_000}`;
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
