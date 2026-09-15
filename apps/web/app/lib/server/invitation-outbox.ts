import { createDb, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db, Dialect, SqlDatabase } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { isPermanentFailure, permanentFailure, Queue } from "@lesto/queue";
import type { RunResult, Worker, WorkOptions } from "@lesto/queue";
import { recipientBindingSchema } from "@snackday/domain";
import { z } from "zod";

import { hashBearerToken } from "./bearer-tokens";
import type { InviteDeliverer, InviteDelivery } from "./invite-delivery";
import { invitations } from "./invitations";
import { accounts, people } from "./identity";
import { ownedActiveTeam } from "./teams";

const JOB_NAME = "invitation.delivery";
const QUEUE_NAME = "invitation-delivery";

export const invitationOutbox = defineTable("invitation_delivery_outbox", {
  id: text("id").primaryKey(),
  invitationId: text("invitation_id")
    .notNull()
    .references(() => invitations.id),
  deliveryKey: text("delivery_key").notNull().unique(),
  tokenHash: text("token_hash").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  queuedAt: text("queued_at"),
  deliveredAt: text("delivered_at"),
});

export const createInvitationOutbox: MigrationEntry = {
  version: "012_create_invitation_outbox",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(invitationOutbox, schema.dialect));
      await schema.execute(
        "CREATE INDEX invitation_delivery_outbox_invitation_id_idx ON invitation_delivery_outbox (invitation_id)",
      );
      await schema.execute(
        "CREATE INDEX invitation_delivery_outbox_status_idx ON invitation_delivery_outbox (status)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(invitationOutbox));
    },
  },
};

const sealedSchema = z.strictObject({
  version: z.literal(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

const deliverySchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  invitationId: z.string().min(1),
  teamName: z.string().min(1),
  inviterDisplayName: z.string().min(1),
  invitedRole: z.enum(["owner", "adult"]),
  recipient: recipientBindingSchema,
  inviteUrl: z.string().startsWith("/invite#"),
});

export interface InvitationPayloadCipher {
  seal(delivery: InviteDelivery): Promise<string>;
  open(sealed: string): Promise<InviteDelivery>;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return ownedBytes(Buffer.from(value, "base64"));
}

/** AES-256-GCM keeps raw invitation tokens and recipient addresses out of SQL. */
export function aesGcmInvitationPayloadCipher(secret: Uint8Array): InvitationPayloadCipher {
  if (secret.byteLength !== 32) {
    throw new Error("Invitation outbox encryption key must contain exactly 32 bytes.");
  }

  const key = crypto.subtle.importKey("raw", ownedBytes(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async seal(delivery) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await key,
        encoder.encode(JSON.stringify(delivery)),
      );
      return JSON.stringify({
        version: 1,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      });
    },

    async open(sealed) {
      const envelope = sealedSchema.parse(JSON.parse(sealed));
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
        await key,
        base64ToBytes(envelope.ciphertext),
      );
      return deliverySchema.parse(JSON.parse(decoder.decode(plaintext)));
    },
  };
}

export interface InvitationDeliveryIntent {
  readonly invitationId: string;
  readonly tokenHash: string;
  readonly delivery: InviteDelivery;
}

export interface InvitationOutbox {
  transaction<R>(
    operation: (db: Db, persist: (intent: InvitationDeliveryIntent) => Promise<void>) => Promise<R>,
  ): Promise<R>;
  requestSchedule(): Promise<void>;
  schedulePending(): Promise<number>;
  runOnce(): Promise<RunResult | null>;
  drain(): Promise<number>;
  work(options?: WorkOptions): Promise<Worker>;
}

export interface InvitationOutboxOptions {
  readonly sql: SqlDatabase;
  readonly dialect?: Dialect;
  readonly deliverer: InviteDeliverer;
  readonly cipher: InvitationPayloadCipher;
  readonly clock?: () => number;
  readonly onSchedulingError: (error: unknown) => void;
}

function deliveryKey(invitationId: string, tokenHash: string): string {
  return `invitation:${invitationId}:${tokenHash}`;
}

function recipientMatchesInvitation(
  delivery: InviteDelivery,
  invitation: {
    readonly recipientKind: string | null;
    readonly recipientEmail: string | null;
    readonly recipientPersonId: string | null;
  },
) {
  return delivery.recipient.kind === "verified_email"
    ? invitation.recipientKind === "verified_email" &&
        invitation.recipientEmail === delivery.recipient.email
    : invitation.recipientKind === "confirmed_person" &&
        invitation.recipientPersonId === delivery.recipient.personId;
}

async function cancel(db: Db, id: string, nowIso: string): Promise<void> {
  await db
    .update(invitationOutbox)
    .set({ status: "cancelled", updatedAt: nowIso })
    .where(eq(invitationOutbox.id, id))
    .run();
}

export function createInvitationOutboxOperations(
  options: InvitationOutboxOptions,
): InvitationOutbox {
  const clock = options.clock ?? Date.now;
  const queueClock = () => new Date(clock());
  const db = createDb(
    options.sql,
    options.dialect === undefined ? {} : { dialect: options.dialect },
  );
  const queue = new Queue({
    db: options.sql,
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    clock: queueClock,
    defaultQueue: QUEUE_NAME,
  });

  queue.define(JOB_NAME, async (payload) => {
    const parsed = z.strictObject({ outboxId: z.string().min(1) }).safeParse(payload);
    if (!parsed.success) throw permanentFailure(new Error("Invalid invitation outbox job."));

    const outbox = await db
      .select()
      .from(invitationOutbox)
      .where(eq(invitationOutbox.id, parsed.data.outboxId))
      .get();
    if (outbox === undefined || outbox.status !== "pending") return;

    const invitation = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, outbox.invitationId))
      .get();
    const nowIso = new Date(clock()).toISOString();
    if (
      invitation === undefined ||
      invitation.status !== "pending" ||
      invitation.expiresAt <= nowIso ||
      invitation.tokenHash !== outbox.tokenHash
    ) {
      await cancel(db, outbox.id, nowIso);
      return;
    }

    const team = await ownedActiveTeam(db, invitation.teamId, invitation.createdByPersonId);
    if (team === undefined) {
      await cancel(db, outbox.id, nowIso);
      return;
    }
    const inviter = await db
      .select()
      .from(people)
      .where(eq(people.id, invitation.createdByPersonId))
      .get();
    if (inviter === undefined || inviter.status !== "active") {
      await cancel(db, outbox.id, nowIso);
      return;
    }
    const inviterAccount = await db
      .select()
      .from(accounts)
      .where(eq(accounts.personId, invitation.createdByPersonId))
      .get();
    if (inviterAccount === undefined || inviterAccount.status !== "active") {
      await cancel(db, outbox.id, nowIso);
      return;
    }

    let delivery: InviteDelivery;
    try {
      delivery = await options.cipher.open(outbox.encryptedPayload);
    } catch {
      throw permanentFailure(new Error("Invitation outbox payload could not be decrypted."));
    }
    const deliveredTokenHash = await hashBearerToken(delivery.inviteUrl.slice("/invite#".length));
    if (
      delivery.idempotencyKey !== outbox.deliveryKey ||
      delivery.invitationId !== invitation.id ||
      deliveredTokenHash !== outbox.tokenHash
    ) {
      throw permanentFailure(new Error("Invitation outbox payload does not match current intent."));
    }
    if (
      delivery.invitedRole !== invitation.invitedRole ||
      !recipientMatchesInvitation(delivery, invitation)
    ) {
      await cancel(db, outbox.id, nowIso);
      return;
    }

    try {
      await options.deliverer.deliver({
        ...delivery,
        teamName: team.name,
        inviterDisplayName: inviter.displayName,
      });
    } catch (error) {
      const safeError = new Error("Invitation delivery provider failed.");
      throw isPermanentFailure(error) ? permanentFailure(safeError) : safeError;
    }
    await db
      .update(invitationOutbox)
      .set({ status: "delivered", updatedAt: nowIso, deliveredAt: nowIso })
      .where(eq(invitationOutbox.id, outbox.id))
      .run();
  });

  return {
    transaction(operation) {
      return options.sql.transaction(async (transactionSql) => {
        const transactionDb = createDb(transactionSql);
        return operation(transactionDb, async (intent) => {
          const key = deliveryKey(intent.invitationId, intent.tokenHash);
          const nowIso = new Date(clock()).toISOString();
          const encryptedPayload = await options.cipher.seal({
            ...intent.delivery,
            idempotencyKey: key,
          });
          const id = `invitation_delivery_${crypto.randomUUID()}`;
          await transactionDb
            .insert(invitationOutbox)
            .values({
              id,
              invitationId: intent.invitationId,
              deliveryKey: key,
              tokenHash: intent.tokenHash,
              encryptedPayload,
              status: "pending",
              createdAt: nowIso,
              updatedAt: nowIso,
              queuedAt: null,
              deliveredAt: null,
            })
            .run();
        });
      });
    },
    async requestSchedule() {
      try {
        await this.schedulePending();
      } catch (error) {
        try {
          options.onSchedulingError(error);
        } catch {
          // A broken observer must not change a persisted source operation.
        }
      }
    },
    async schedulePending() {
      const pending = await db
        .select()
        .from(invitationOutbox)
        .where(eq(invitationOutbox.status, "pending"))
        .all();
      let scheduled = 0;
      for (const row of pending) {
        if (row.queuedAt !== null) continue;
        await queue.enqueue(JOB_NAME, { outboxId: row.id }, { maxAttempts: 8 });
        const nowIso = new Date(clock()).toISOString();
        await db
          .update(invitationOutbox)
          .set({ queuedAt: nowIso, updatedAt: nowIso })
          .where(eq(invitationOutbox.id, row.id))
          .run();
        scheduled += 1;
      }
      return scheduled;
    },
    runOnce: () => queue.runOnce({ queue: QUEUE_NAME }),
    async drain() {
      let processed = 0;
      while ((await this.runOnce()) !== null) processed += 1;
      return processed;
    },
    async work(workOptions = {}) {
      await this.schedulePending();
      return queue.work({ ...workOptions, queue: QUEUE_NAME });
    },
  };
}
