import { eq } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { HandleOptions, Lesto, LestoResponse } from "@lesto/web";

import type { SessionService as Sessions } from "../lib/server/application-contracts";
import {
  accounts,
  DEV_SESSION_TTL_MS,
  developmentSessionCookie,
  people,
} from "../lib/server/identity";
import type { AdultIdentity } from "../lib/server/identity";
import { DEV_SIGN_IN_PAGE_PATH, isSeedOnlyPersona, seedPersona } from "./seed-personas";
import type { SeedPersona } from "./seed-personas";
import { devSignInPage } from "./sign-in-page";

export const DEV_SIGN_IN_API_PATH = "/api/dev/sign-in";

export interface DevSignInOptions {
  readonly enabled: boolean;
  readonly db: Db;
  readonly sessions: Sessions;
}

function requestedSeedPersona(body: unknown): SeedPersona | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "persona") return undefined;
  const key = (body as { readonly persona?: unknown }).persona;
  if (typeof key !== "string" || !isSeedOnlyPersona(key)) return undefined;
  return seedPersona(key);
}

async function seededIdentity(db: Db, persona: SeedPersona): Promise<AdultIdentity | undefined> {
  const account = await db.select().from(accounts).where(eq(accounts.id, persona.accountId)).get();
  if (account === undefined || account.status !== "active") return undefined;
  if (account.personId !== persona.personId) return undefined;
  const person = await db.select().from(people).where(eq(people.id, persona.personId)).get();
  if (person === undefined || person.status !== "active") return undefined;
  return {
    account: { id: account.id },
    person: { id: person.id, displayName: person.displayName },
  };
}

async function signInSeedPersona(
  options: DevSignInOptions,
  persona: SeedPersona,
): Promise<LestoResponse | undefined> {
  const identity = await seededIdentity(options.db, persona);
  if (identity === undefined) return undefined;
  const session = await options.sessions.create(identity.account.id, DEV_SESSION_TTL_MS);
  return {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": developmentSessionCookie(session.token),
    },
    body: JSON.stringify(identity),
  };
}

function isSignInRequest(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === DEV_SIGN_IN_API_PATH;
}

export function registerDevSignIn(app: Lesto, options: DevSignInOptions): Lesto {
  if (!options.enabled) return app;
  if (options.sessions.mode !== "development") {
    throw new Error("Development role sign-in requires development session services.");
  }
  app.page(DEV_SIGN_IN_PAGE_PATH, devSignInPage);
  const handle = app.handle.bind(app);
  app.handle = async (method: string, path: string, handleOptions?: HandleOptions) => {
    if (isSignInRequest(method, path)) {
      const persona = requestedSeedPersona(handleOptions?.body);
      const signedIn =
        persona === undefined ? undefined : await signInSeedPersona(options, persona);
      if (signedIn !== undefined) return signedIn;
    }
    return handle(method, path, handleOptions);
  };
  return app;
}
