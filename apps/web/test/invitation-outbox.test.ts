import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, eq } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import { installSchema as installQueueSchema } from "@lesto/queue";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import { afterEach, describe, expect, it } from "vitest";

import { accounts, createIdentity, people } from "../app/lib/server/identity";
import type {
  InviteDeliverer,
  InviteDelivery,
} from "../app/lib/server/invite-delivery";
import {
  aesGcmInvitationPayloadCipher,
  createInvitationOutbox,
  createInvitationOutboxOperations,
  invitationOutbox,
} from "../app/lib/server/invitation-outbox";
import {
  createInvitationRecipientBinding,
  createInvitations,
  hashInviteToken,
  invitations,
} from "../app/lib/server/invitations";
import { createRoster } from "../app/lib/server/roster";
import { createTeamsAndSeasons, teams } from "../app/lib/server/teams";

const directories: string[] = [];
const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const TOKEN = "a".repeat(64);
const TOKEN_HASH = await hashInviteToken(TOKEN);
const EMAIL = "recipient@example.test";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "snackduty-outbox-"));
  directories.push(directory);
  return join(directory, "snackduty.db");
}

async function openDatabase(path: string) {
  const opened = await openSqlite(path);
  await createApp({
    db: opened.db,
    app: lesto(),
    secure: false,
    migrations: [
      createIdentity,
      createTeamsAndSeasons,
      createRoster,
      createInvitations,
      createInvitationRecipientBinding,
      createInvitationOutbox,
    ],
    schemas: [installQueueSchema],
  });
  return { ...opened, typed: createDb(opened.db) };
}

async function seedInvitation(
  db: ReturnType<typeof createDb>,
  tokenHash = TOKEN_HASH,
) {
  const nowIso = new Date(NOW).toISOString();
  await db
    .insert(people)
    .values({
      id: "person_owner",
      displayName: "Owner",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  await db
    .insert(accounts)
    .values({
      id: "account_owner",
      personId: "person_owner",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  await db
    .insert(teams)
    .values({
      id: "team_outbox",
      name: "Outbox Falcons",
      status: "active",
      createdByPersonId: "person_owner",
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  await db
    .insert(invitations)
    .values({
      id: "invitation_outbox",
      teamId: "team_outbox",
      invitedRole: "adult",
      participantId: null,
      relationship: null,
      inviteeLabel: "Private label",
      tokenHash,
      status: "pending",
      createdByPersonId: "person_owner",
      acceptedByPersonId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(NOW + 60_000).toISOString(),
      recipientKind: "verified_email",
      recipientEmail: EMAIL,
      recipientPersonId: null,
      replacesGuardianRelationshipId: null,
    })
    .run();
}

function delivery(tokenHash = TOKEN_HASH): {
  tokenHash: string;
  delivery: InviteDelivery;
  invitationId: string;
} {
  return {
    invitationId: "invitation_outbox",
    tokenHash,
    delivery: {
      invitationId: "invitation_outbox",
      teamName: "Outbox Falcons",
      inviterDisplayName: "Owner",
      invitedRole: "adult",
      recipient: { kind: "verified_email", email: EMAIL },
      inviteUrl: `/invite#${TOKEN}`,
    },
  };
}

describe("durable invitation outbox", () => {
  it("rolls delivery intent back with its source transaction", async () => {
    const opened = await openDatabase(await databasePath());
    const outbox = createInvitationOutboxOperations({
      sql: opened.db,
      deliverer: {
        deliver: () => Promise.resolve(),
        currentLink: () => undefined,
      },
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(1)),
      clock: () => NOW,
      onSchedulingError: () => {},
    });
    await seedInvitation(opened.typed);

    await expect(
      outbox.transaction(async (transactionDb, persist) => {
        await transactionDb
          .update(invitations)
          .set({ inviteeLabel: "must roll back" })
          .where(eq(invitations.id, "invitation_outbox"))
          .run();
        await persist(delivery());
        throw new Error("source operation failed");
      }),
    ).rejects.toThrow("source operation failed");

    expect(
      await opened.db.prepare("SELECT invitee_label FROM invitations").get(),
    ).toEqual({
      invitee_label: "Private label",
    });
    expect(
      await opened.db
        .prepare("SELECT id FROM invitation_delivery_outbox")
        .all(),
    ).toEqual([]);
    opened.close();
  });

  it("commits encrypted intent before scheduling and delivers with one idempotency key", async () => {
    const opened = await openDatabase(await databasePath());
    const delivered: InviteDelivery[] = [];
    const deliverer: InviteDeliverer = {
      deliver(value) {
        delivered.push(value);
        return Promise.resolve();
      },
      currentLink: () => undefined,
    };
    const outbox = createInvitationOutboxOperations({
      sql: opened.db,
      deliverer,
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
      clock: () => NOW,
      onSchedulingError: () => {},
    });
    await seedInvitation(opened.typed);
    await outbox.transaction(async (_db, persist) => persist(delivery()));

    const stored = (await opened.db
      .prepare(
        "SELECT encrypted_payload, status, queued_at FROM invitation_delivery_outbox",
      )
      .get()) as {
      encrypted_payload: string;
      status: string;
      queued_at: string | null;
    };
    expect(stored.status).toBe("pending");
    expect(stored.queued_at).toBeNull();
    expect(stored.encrypted_payload).not.toContain(TOKEN);
    expect(stored.encrypted_payload).not.toContain(EMAIL);

    expect(await outbox.schedulePending()).toBe(1);
    expect(await outbox.drain()).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.idempotencyKey).toBe(
      `invitation:invitation_outbox:${TOKEN_HASH}`,
    );
    expect(
      await opened.db
        .prepare("SELECT status FROM invitation_delivery_outbox")
        .get(),
    ).toEqual({
      status: "delivered",
    });
    opened.close();
  });

  it("recovers a persisted pending intent after scheduling failure and process restart", async () => {
    const path = await databasePath();
    const first = await openDatabase(path);
    const schedulingErrors: unknown[] = [];
    const unavailable: InviteDeliverer = {
      deliver: () => Promise.reject(new Error("provider unavailable")),
      currentLink: () => undefined,
    };
    const firstOutbox = createInvitationOutboxOperations({
      sql: first.db,
      deliverer: unavailable,
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(9)),
      clock: () => NOW,
      onSchedulingError: (error) => schedulingErrors.push(error),
    });
    await seedInvitation(first.typed);
    await firstOutbox.transaction(async (_db, persist) => persist(delivery()));
    await first.db.exec("DROP TABLE lesto_jobs");
    await firstOutbox.requestSchedule();
    expect(schedulingErrors).toHaveLength(1);
    expect(
      await first.db
        .prepare("SELECT status, queued_at FROM invitation_delivery_outbox")
        .get(),
    ).toEqual({ status: "pending", queued_at: null });
    first.close();

    const restarted = await openDatabase(path);
    const delivered: InviteDelivery[] = [];
    const restartedOutbox = createInvitationOutboxOperations({
      sql: restarted.db,
      deliverer: {
        deliver(value) {
          delivered.push(value);
          return Promise.resolve();
        },
        currentLink: () => undefined,
      },
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(9)),
      clock: () => NOW,
      onSchedulingError: () => {},
    });
    expect(await restartedOutbox.schedulePending()).toBe(1);
    expect(await restartedOutbox.runOnce()).toMatchObject({ outcome: "done" });
    expect(delivered).toHaveLength(1);
    restarted.close();
  });

  it("retries a transient provider failure with the same idempotency key", async () => {
    const opened = await openDatabase(await databasePath());
    let now = NOW;
    const attempts: InviteDelivery[] = [];
    const outbox = createInvitationOutboxOperations({
      sql: opened.db,
      deliverer: {
        deliver(value) {
          attempts.push(value);
          return attempts.length === 1
            ? Promise.reject(new Error("temporary provider failure"))
            : Promise.resolve();
        },
        currentLink: () => undefined,
      },
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(5)),
      clock: () => now,
      onSchedulingError: () => {},
    });
    await seedInvitation(opened.typed);
    await outbox.transaction(async (_db, persist) => persist(delivery()));
    await outbox.schedulePending();

    expect(await outbox.runOnce()).toMatchObject({ outcome: "retry" });
    const failedAttempt = (await opened.db
      .prepare("SELECT last_error FROM lesto_jobs")
      .get()) as {
      last_error: string;
    };
    expect(failedAttempt.last_error).toBe(
      "Invitation delivery provider failed.",
    );
    expect(failedAttempt.last_error).not.toContain(EMAIL);
    now += 1_000;
    expect(await outbox.runOnce()).toMatchObject({ outcome: "done" });
    expect(attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      `invitation:invitation_outbox:${TOKEN_HASH}`,
      `invitation:invitation_outbox:${TOKEN_HASH}`,
    ]);
    opened.close();
  });

  it("cancels stale rotated intent before any provider call", async () => {
    const opened = await openDatabase(await databasePath());
    const delivered: InviteDelivery[] = [];
    const outbox = createInvitationOutboxOperations({
      sql: opened.db,
      deliverer: {
        deliver(value) {
          delivered.push(value);
          return Promise.resolve();
        },
        currentLink: () => undefined,
      },
      cipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(3)),
      clock: () => NOW,
      onSchedulingError: () => {},
    });
    await seedInvitation(opened.typed);
    await outbox.transaction(async (_db, persist) => persist(delivery()));
    await outbox.schedulePending();
    await opened.typed
      .update(invitations)
      .set({ tokenHash: "hash-rotated" })
      .where(eq(invitations.id, "invitation_outbox"))
      .run();

    expect(await outbox.runOnce()).toMatchObject({ outcome: "done" });
    expect(delivered).toEqual([]);
    const rows = await opened.typed.select().from(invitationOutbox).all();
    expect(rows[0]?.status).toBe("cancelled");
    opened.close();
  });
});
