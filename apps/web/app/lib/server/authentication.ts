import { and, createTableSql, defineTable, dropTableSql, eq, ne, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { appleSignInInputSchema } from "@snackday/domain";
import { z } from "zod";

import type {
  AuthenticationOperations,
  AuthenticationOptions,
  VerifiedProviderIdentity,
} from "./application-contracts";
import {
  accounts,
  authenticatedAdult,
  clearedSessionCookie,
  people,
  sessionTokenFromCookieHeader,
  VERIFIED_SESSION_COOKIE,
  VERIFIED_SESSION_TTL_MS,
  verifiedSessionCookie,
  developmentSessionCookie,
  DEV_SESSION_COOKIE,
  DEV_SESSION_TTL_MS,
} from "./identity";

const CHALLENGE_TTL_MS = 10 * 60 * 1_000;
const CONSENT_VERSION = "adult-v1";
const verifiedEmailSchema = z.email().trim().toLowerCase();

export const authenticationChallenges = defineTable("authentication_challenges", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
});

export const providerIdentityLinks = defineTable("provider_identity_links", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const verifiedIdentityEmails = defineTable("verified_identity_emails", {
  id: text("id").primaryKey(),
  linkId: text("link_id")
    .notNull()
    .references(() => providerIdentityLinks.id),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  normalizedEmail: text("normalized_email").notNull(),
  status: text("status").notNull(),
  verifiedAt: text("verified_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const adultConsents = defineTable("adult_consents", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  policyVersion: text("policy_version").notNull(),
  provider: text("provider").notNull(),
  consentedAt: text("consented_at").notNull(),
});

export const createAuthenticationSchema: MigrationEntry = {
  version: "010_create_authentication",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(authenticationChallenges, schema.dialect));
      await schema.execute(createTableSql(providerIdentityLinks, schema.dialect));
      await schema.execute(createTableSql(verifiedIdentityEmails, schema.dialect));
      await schema.execute(createTableSql(adultConsents, schema.dialect));
      await schema.addIndex("authentication_challenges", ["provider", "status", "expires_at"]);
      await schema.addIndex("provider_identity_links", ["provider", "issuer", "subject"], {
        unique: true,
      });
      await schema.addIndex("verified_identity_emails", ["account_id", "normalized_email"], {
        unique: true,
      });
      await schema.addIndex("verified_identity_emails", ["link_id", "status"]);
      await schema.addIndex("adult_consents", ["account_id", "policy_version"], { unique: true });
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(adultConsents));
      await schema.execute(dropTableSql(verifiedIdentityEmails));
      await schema.execute(dropTableSql(providerIdentityLinks));
      await schema.execute(dropTableSql(authenticationChallenges));
    },
  },
};

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function projectAccount(db: Db, accountId: string) {
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (account === undefined || account.status !== "active") return undefined;
  const person = await db.select().from(people).where(eq(people.id, account.personId)).get();
  if (person === undefined || person.status !== "active") return undefined;
  return {
    account: { id: account.id },
    person: { id: person.id, displayName: person.displayName },
  };
}

async function recordVerifiedEmail(
  tx: Db,
  link: { readonly id: string; readonly accountId: string },
  identity: VerifiedProviderIdentity,
  now: string,
): Promise<void> {
  if (!identity.emailVerified || identity.email === undefined) return;
  const parsed = verifiedEmailSchema.safeParse(identity.email);
  if (!parsed.success) return;
  const normalizedEmail = parsed.data;
  await tx
    .update(verifiedIdentityEmails)
    .set({ status: "inactive", updatedAt: now })
    .where(
      and(
        eq(verifiedIdentityEmails.linkId, link.id),
        eq(verifiedIdentityEmails.status, "active"),
        ne(verifiedIdentityEmails.normalizedEmail, normalizedEmail),
      ),
    )
    .run();
  const existing = await tx
    .select()
    .from(verifiedIdentityEmails)
    .where(
      and(
        eq(verifiedIdentityEmails.accountId, link.accountId),
        eq(verifiedIdentityEmails.normalizedEmail, normalizedEmail),
      ),
    )
    .get();
  if (existing === undefined) {
    await tx
      .insert(verifiedIdentityEmails)
      .values({
        id: `verified_email_${crypto.randomUUID()}`,
        linkId: link.id,
        accountId: link.accountId,
        normalizedEmail,
        status: "active",
        verifiedAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    await tx
      .update(verifiedIdentityEmails)
      .set({ linkId: link.id, status: "active", verifiedAt: now, updatedAt: now })
      .where(eq(verifiedIdentityEmails.id, existing.id))
      .run();
  }
}

async function resolveProviderIdentity(
  tx: Db,
  identity: VerifiedProviderIdentity,
  displayName: string | undefined,
  now: string,
) {
  let link = await tx
    .select()
    .from(providerIdentityLinks)
    .where(
      and(
        eq(providerIdentityLinks.provider, "apple"),
        eq(providerIdentityLinks.issuer, identity.issuer),
        eq(providerIdentityLinks.subject, identity.subject),
      ),
    )
    .get();
  if (link === undefined) {
    const personId = `person_${crypto.randomUUID()}`;
    const accountId = `account_${crypto.randomUUID()}`;
    await tx
      .insert(people)
      .values({
        id: personId,
        displayName: displayName?.trim() || "Apple user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await tx
      .insert(accounts)
      .values({
        id: accountId,
        personId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    link = await tx
      .insert(providerIdentityLinks)
      .values({
        id: `provider_identity_${crypto.randomUUID()}`,
        provider: "apple",
        issuer: identity.issuer,
        subject: identity.subject,
        accountId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  const projected = await projectAccount(tx, link.accountId);
  if (projected === undefined) return undefined;
  await recordVerifiedEmail(tx, link, identity, now);
  const existingConsent = await tx
    .select()
    .from(adultConsents)
    .where(
      and(
        eq(adultConsents.accountId, link.accountId),
        eq(adultConsents.policyVersion, CONSENT_VERSION),
      ),
    )
    .get();
  if (existingConsent === undefined) {
    await tx
      .insert(adultConsents)
      .values({
        id: `adult_consent_${crypto.randomUUID()}`,
        accountId: link.accountId,
        policyVersion: CONSENT_VERSION,
        provider: "apple",
        consentedAt: now,
      })
      .run();
  }
  return projected;
}

export function createAuthentication(options: AuthenticationOptions): AuthenticationOperations {
  return {
    async challenge() {
      const nonce = randomToken();
      const challengeId = `auth_challenge_${crypto.randomUUID()}`;
      const now = options.clock();
      await options.db
        .insert(authenticationChallenges)
        .values({
          id: challengeId,
          provider: "apple",
          nonceHash: await sha256(nonce),
          status: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
          consumedAt: null,
        })
        .run();
      return { challengeId, nonce };
    },

    async signIn(rawInput) {
      const input = appleSignInInputSchema.parse(rawInput);
      if (options.appleVerifier === undefined) return undefined;
      const challenge = await options.db
        .select()
        .from(authenticationChallenges)
        .where(
          and(
            eq(authenticationChallenges.id, input.challengeId),
            eq(authenticationChallenges.provider, "apple"),
            eq(authenticationChallenges.status, "pending"),
          ),
        )
        .get();
      if (challenge === undefined || Date.parse(challenge.expiresAt) <= options.clock())
        return undefined;

      const verified = await options.appleVerifier.verify(input.identityToken, challenge.nonceHash);
      if (verified === undefined) return undefined;
      const identity = await options.db.transaction(async (tx) => {
        const live = await tx
          .select()
          .from(authenticationChallenges)
          .where(
            and(
              eq(authenticationChallenges.id, input.challengeId),
              eq(authenticationChallenges.provider, "apple"),
              eq(authenticationChallenges.status, "pending"),
            ),
          )
          .get();
        if (live === undefined || Date.parse(live.expiresAt) <= options.clock()) return undefined;
        const now = new Date(options.clock()).toISOString();
        const consumed = await tx
          .update(authenticationChallenges)
          .set({ status: "consumed", consumedAt: now })
          .where(
            and(
              eq(authenticationChallenges.id, live.id),
              eq(authenticationChallenges.status, "pending"),
            ),
          )
          .run();
        if (consumed.changes !== 1) return undefined;
        return resolveProviderIdentity(tx, verified, input.displayName, now);
      });
      if (identity === undefined) return undefined;
      const ttl = options.secureCookies ? VERIFIED_SESSION_TTL_MS : DEV_SESSION_TTL_MS;
      const session = await options.sessions.create(identity.account.id, ttl);
      return {
        identity,
        cookie: options.secureCookies
          ? verifiedSessionCookie(session.token)
          : developmentSessionCookie(session.token),
      };
    },

    current(cookieHeader) {
      const token = sessionTokenFromCookieHeader(cookieHeader, options.secureCookies);
      if (token === undefined) return Promise.resolve(undefined);
      const name = options.secureCookies ? VERIFIED_SESSION_COOKIE : DEV_SESSION_COOKIE;
      return authenticatedAdult(options.db, options.sessions, `${name}=${token}`);
    },

    async logout(cookieHeader) {
      const token = sessionTokenFromCookieHeader(cookieHeader, options.secureCookies);
      if (token !== undefined) await options.sessions.revoke(token);
      return clearedSessionCookie(options.secureCookies);
    },
  };
}

export async function verifiedRecipientEmails(
  db: Db,
  personId: string,
): Promise<readonly string[]> {
  const person = await db.select().from(people).where(eq(people.id, personId)).get();
  if (person === undefined || person.status !== "active") return [];
  const account = await db.select().from(accounts).where(eq(accounts.personId, personId)).get();
  if (account === undefined || account.status !== "active") return [];
  const emails = await db
    .select()
    .from(verifiedIdentityEmails)
    .where(
      and(
        eq(verifiedIdentityEmails.accountId, account.id),
        eq(verifiedIdentityEmails.status, "active"),
      ),
    )
    .all();
  return [...new Set(emails.map((row) => row.normalizedEmail))].toSorted();
}
