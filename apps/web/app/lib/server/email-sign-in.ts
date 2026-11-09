import { and, createTableSql, defineTable, dropTableSql, eq, gt, lte, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Lesto } from "@lesto/web";
import {
  adultIdentitySchema,
  emailSignInStartedSchema,
  emailSignInPreviewInputSchema,
  emailSignInPreviewSchema,
  emailSignInStartInputSchema,
  emailSignInVerifyInputSchema,
} from "@snackday/domain";
import type { AuthenticatedIdentity } from "@snackday/domain";
import type { z } from "zod";

import type { Clock, SessionService } from "./application-contracts";
import { resolveProviderIdentity, startSession } from "./authentication";
import { generateBearerToken, hashBearerToken } from "./bearer-tokens";
import type { EmailTransport } from "./email";

export const EMAIL_SIGN_IN_ISSUER = "snackday-email-link";
export const EMAIL_SIGN_IN_TTL_MS = 15 * 60 * 1_000;
/** Links one address may request inside one TTL window before requests go quiet. */
export const EMAIL_SIGN_IN_LIMIT_PER_WINDOW = 5;
const EMAIL_SIGN_IN_TTL_MINUTES = EMAIL_SIGN_IN_TTL_MS / (60 * 1_000);

export const emailSignInLinks = defineTable("email_sign_in_links", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  normalizedEmail: text("normalized_email").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  sentAt: text("sent_at"),
  consumedAt: text("consumed_at"),
});

export const createEmailSignInSchema: MigrationEntry = {
  version: "017_create_email_sign_in_links",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(emailSignInLinks, schema.dialect));
      await schema.addIndex("email_sign_in_links", ["normalized_email", "created_at"]);
      await schema.addIndex("email_sign_in_links", ["expires_at"]);
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(emailSignInLinks));
    },
  },
};

export interface EmailSignInDelivery {
  readonly transport: EmailTransport;
  /** The HTTPS origin the `/sign-in#<token>` link is resolved against. */
  readonly publicBaseUrl: URL;
}

export interface EmailSignInOptions {
  readonly db: Db;
  readonly sessions: SessionService;
  readonly clock: Clock;
  readonly secureCookies: boolean;
  readonly delivery?: EmailSignInDelivery;
}

export type EmailSignInStartOutcome = "sent" | "unavailable";

export interface EmailSignInOperations {
  start(input: z.infer<typeof emailSignInStartInputSchema>): Promise<EmailSignInStartOutcome>;
  /** Names the account a live link signs in to, without using the link up. */
  preview(
    input: z.infer<typeof emailSignInPreviewInputSchema>,
  ): Promise<z.infer<typeof emailSignInPreviewSchema> | undefined>;
  verify(
    input: z.infer<typeof emailSignInVerifyInputSchema>,
  ): Promise<{ readonly identity: AuthenticatedIdentity; readonly cookie: string } | undefined>;
}

/** The token rides in the fragment, which no browser sends to a server or a log. */
export function emailSignInPath(token: string): string {
  return `/sign-in#${token}`;
}

export function emailSignInText(link: string): string {
  return [
    "Use this link to sign in to Snackday:",
    link,
    "",
    `The link works once, for ${EMAIL_SIGN_IN_TTL_MINUTES} minutes.`,
    "If you did not ask to sign in, you can ignore this email.",
  ].join("\n");
}

/** `pat@example.test` → `p***@example.test`: enough to spot a link for someone else's account. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

async function liveLink(db: Db, token: string, nowIso: string) {
  const tokenHash = await hashBearerToken(token);
  return db
    .select()
    .from(emailSignInLinks)
    .where(
      and(
        eq(emailSignInLinks.tokenHash, tokenHash),
        eq(emailSignInLinks.status, "pending"),
        gt(emailSignInLinks.expiresAt, nowIso),
      ),
    )
    .get();
}

export function createEmailSignIn(options: EmailSignInOptions): EmailSignInOperations {
  return {
    async preview(input) {
      const link = await liveLink(options.db, input.token, new Date(options.clock()).toISOString());
      return link === undefined ? undefined : { maskedEmail: maskEmail(link.normalizedEmail) };
    },

    async start(input) {
      const delivery = options.delivery;
      if (delivery === undefined) return "unavailable";

      const token = generateBearerToken();
      const tokenHash = await hashBearerToken(token);
      const now = options.clock();
      const nowIso = new Date(now).toISOString();
      const id = `email_sign_in_${crypto.randomUUID()}`;
      const issued = await options.db.transaction(async (tx) => {
        await tx.delete(emailSignInLinks).where(lte(emailSignInLinks.expiresAt, nowIso)).run();
        const recent = await tx
          .select()
          .from(emailSignInLinks)
          .where(
            and(
              eq(emailSignInLinks.normalizedEmail, input.email),
              gt(emailSignInLinks.expiresAt, nowIso),
            ),
          )
          .all();
        if (recent.length >= EMAIL_SIGN_IN_LIMIT_PER_WINDOW) return false;
        await tx
          .insert(emailSignInLinks)
          .values({
            id,
            tokenHash,
            normalizedEmail: input.email,
            status: "pending",
            createdAt: nowIso,
            expiresAt: new Date(now + EMAIL_SIGN_IN_TTL_MS).toISOString(),
            sentAt: null,
            consumedAt: null,
          })
          .run();
        return true;
      });
      // A throttled request answers like a sent one, so the response never
      // tells a caller how often an address has asked.
      if (!issued) return "sent";

      const link = new URL(emailSignInPath(token), delivery.publicBaseUrl).toString();
      try {
        await delivery.transport.send({
          to: input.email,
          subject: "Your Snackday sign-in link",
          text: emailSignInText(link),
          idempotencyKey: `sign-in:${id}`,
        });
      } catch {
        return "unavailable";
      }
      await options.db
        .update(emailSignInLinks)
        .set({ sentAt: new Date(options.clock()).toISOString() })
        .where(eq(emailSignInLinks.id, id))
        .run();
      return "sent";
    },

    async verify(input) {
      const identity = await options.db.transaction(async (tx) => {
        const nowIso = new Date(options.clock()).toISOString();
        const link = await liveLink(tx, input.token, nowIso);
        if (link === undefined) return undefined;
        const consumed = await tx
          .update(emailSignInLinks)
          .set({ status: "consumed", consumedAt: nowIso })
          .where(and(eq(emailSignInLinks.id, link.id), eq(emailSignInLinks.status, "pending")))
          .run();
        if (consumed.changes !== 1) return undefined;
        return resolveProviderIdentity(
          tx,
          "email",
          {
            issuer: EMAIL_SIGN_IN_ISSUER,
            subject: link.normalizedEmail,
            email: link.normalizedEmail,
            emailVerified: true,
          },
          input.displayName,
          nowIso,
        );
      });
      if (identity === undefined) return undefined;
      return { identity, cookie: await startSession(options, identity.account.id) };
    },
  };
}

const emailSignInUnavailable = { error: "email sign-in unavailable" } as const;
const authenticationFailed = { error: "authentication failed" } as const;

export function registerEmailSignInRoutes(app: Lesto, operations: EmailSignInOperations) {
  return app
    .post("/api/auth/email/start", async (c) => {
      const outcome = await operations.start(c.valid(emailSignInStartInputSchema));
      return outcome === "sent"
        ? c.json(emailSignInStartedSchema.parse({ sent: true }), 202)
        : c.json(emailSignInUnavailable, 503);
    })
    .post("/api/auth/email/preview", async (c) => {
      const preview = await operations.preview(c.valid(emailSignInPreviewInputSchema));
      return preview === undefined
        ? c.json(authenticationFailed, 401)
        : c.json(emailSignInPreviewSchema.parse(preview));
    })
    .post("/api/auth/email/verify", async (c) => {
      const signedIn = await operations.verify(c.valid(emailSignInVerifyInputSchema));
      if (signedIn === undefined) return c.json(authenticationFailed, 401);
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": signedIn.cookie,
        },
        body: JSON.stringify(adultIdentitySchema.parse(signedIn.identity)),
      };
    });
}
