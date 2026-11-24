import { createDb, createTableSql, defineTable, dropTableSql, eq, integer, text } from "@lesto/db";
import type { Dialect, InferRow, SqlDatabase } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { isPermanentFailure, permanentFailure, Queue } from "@lesto/queue";
import type { JobEvent, RunResult, Worker, WorkOptions } from "@lesto/queue";
import { z } from "zod";

import type { EmailTransport } from "../lib/server/email";
import { quotedEmailText } from "../lib/server/invite-email";
import { BOOKING_FIELD_MAX_LENGTH } from "./booking-form";
import type { LessonRequestInput } from "./booking-form";
import { coachTitle, lessonTypes } from "./content";

const JOB_NAME = "lesson_request.email";
const QUEUE_NAME = "lesson-request-email";
const MAX_ATTEMPTS = 8;
const FAILED_JOB_PAGE_SIZE = 100;

export const LESSON_REQUEST_EMAIL_SUBJECT = "New lesson request";

export const lessonRequests = defineTable("lesson_requests", {
  id: text("id").primaryKey(),
  parentName: text("parent_name").notNull(),
  parentEmail: text("parent_email").notNull(),
  phone: text("phone"),
  playerAge: integer("player_age").notNull(),
  lessonType: text("lesson_type").notNull(),
  city: text("city").notNull(),
  preferredTimes: text("preferred_times").notNull(),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const lessonRequestOutbox = defineTable("lesson_request_outbox", {
  id: text("id").primaryKey(),
  lessonRequestId: text("lesson_request_id")
    .notNull()
    .references(() => lessonRequests.id),
  deliveryKey: text("delivery_key").notNull().unique(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  queuedAt: text("queued_at"),
  deliveredAt: text("delivered_at"),
});

export const createLessonRequests: MigrationEntry = {
  version: "019_create_lesson_requests",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(lessonRequests, schema.dialect));
      await schema.execute(createTableSql(lessonRequestOutbox, schema.dialect));
      await schema.execute(
        "CREATE INDEX lesson_request_outbox_status_idx ON lesson_request_outbox (status)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(lessonRequestOutbox));
      await schema.execute(dropTableSql(lessonRequests));
    },
  },
};

type LessonRequestRow = InferRow<typeof lessonRequests>;

/** Where a lesson request email goes. Both halves come from runtime configuration. */
export interface LessonRequestDelivery {
  readonly transport: EmailTransport;
  readonly to: string;
}

export interface LessonRequestOperations {
  /** Stores the request and its outbox row in one batch, then schedules the email. */
  record(request: LessonRequestInput): Promise<string>;
  requestSchedule(): Promise<void>;
  schedulePending(): Promise<number>;
  /** Re-queues every failed email job whose request is still waiting for its email. */
  recoverFailed(): Promise<number>;
  runOnce(): Promise<RunResult | null>;
  drain(): Promise<number>;
  work(options?: WorkOptions): Promise<Worker>;
}

export interface LessonRequestOptions {
  readonly sql: SqlDatabase;
  readonly dialect?: Dialect;
  readonly clock?: () => number;
  readonly delivery?: LessonRequestDelivery;
  readonly onSchedulingError: (error: unknown) => void;
  /** Receives only the queue job id; never the request or its contents. */
  readonly onDeliveryFailed?: (jobId: number) => void;
}

const outboxJobPayload = z.strictObject({ outboxId: z.string().min(1) });

function deliveryKey(lessonRequestId: string): string {
  return `lesson-request:${lessonRequestId}`;
}

function lessonTypeName(id: string): string {
  return lessonTypes.find((lesson) => lesson.id === id)?.name ?? "Unknown";
}

function quoted(value: string | null, field: keyof typeof BOOKING_FIELD_MAX_LENGTH): string {
  return value === null ? "(not given)" : quotedEmailText(value, BOOKING_FIELD_MAX_LENGTH[field]);
}

/**
 * Fixed copy first; every parent-typed value appears only in quotes. Free text
 * loses line breaks, URL separators and dots between words. The email address
 * and phone keep their characters so the coach can reply, because the form
 * schema already limits them to an address and to phone characters.
 */
export function lessonRequestEmailText(request: LessonRequestRow): string {
  return [
    `A parent asked for a lesson on the ${coachTitle} site.`,
    "",
    `Lesson: ${lessonTypeName(request.lessonType)}`,
    `Player age: ${request.playerAge}`,
    `Parent: ${quoted(request.parentName, "parentName")}`,
    `Email: "${request.parentEmail}"`,
    `Phone: ${request.phone === null ? "(not given)" : `"${request.phone}"`}`,
    `City: ${quoted(request.city, "city")}`,
    `Days and times: ${quoted(request.preferredTimes, "preferredTimes")}`,
    `Notes: ${quoted(request.notes, "notes")}`,
    "",
    "Reply to the parent by email to set a time and send a pay link.",
  ].join("\n");
}

const idleWorker: Worker = { stop: () => Promise.resolve() };

export function createLessonRequestOperations(
  options: LessonRequestOptions,
): LessonRequestOperations {
  const clock = options.clock ?? Date.now;
  const dialectOption = options.dialect === undefined ? {} : { dialect: options.dialect };
  const db = createDb(options.sql, dialectOption);
  const queue = new Queue({
    db: options.sql,
    ...dialectOption,
    clock: () => new Date(clock()),
    defaultQueue: QUEUE_NAME,
  });
  const nowIso = () => new Date(clock()).toISOString();

  queue.define(JOB_NAME, async (payload) => {
    const parsed = outboxJobPayload.safeParse(payload);
    if (!parsed.success) throw permanentFailure(new Error("Invalid lesson request outbox job."));

    const outbox = await db
      .select()
      .from(lessonRequestOutbox)
      .where(eq(lessonRequestOutbox.id, parsed.data.outboxId))
      .get();
    if (outbox === undefined || outbox.status !== "pending") return;

    const request = await db
      .select()
      .from(lessonRequests)
      .where(eq(lessonRequests.id, outbox.lessonRequestId))
      .get();
    if (request === undefined) {
      await db
        .update(lessonRequestOutbox)
        .set({ status: "cancelled", updatedAt: nowIso() })
        .where(eq(lessonRequestOutbox.id, outbox.id))
        .run();
      return;
    }
    if (options.delivery === undefined) {
      throw new Error("Lesson request email is not configured.");
    }

    try {
      await options.delivery.transport.send({
        to: options.delivery.to,
        subject: LESSON_REQUEST_EMAIL_SUBJECT,
        text: lessonRequestEmailText(request),
        replyTo: request.parentEmail,
        idempotencyKey: outbox.deliveryKey,
      });
    } catch (error) {
      const safeError = new Error("Lesson request email provider failed.");
      throw isPermanentFailure(error) ? permanentFailure(safeError) : safeError;
    }
    const deliveredAt = nowIso();
    await db
      .update(lessonRequestOutbox)
      .set({ status: "delivered", updatedAt: deliveredAt, deliveredAt })
      .where(eq(lessonRequestOutbox.id, outbox.id))
      .run();
  });

  function observeJob(event: JobEvent): void {
    if (event.name !== JOB_NAME || event.outcome !== "failed") return;
    try {
      options.onDeliveryFailed?.(event.id);
    } catch {
      // A broken observer must not change the queue's outcome.
    }
  }

  async function isWaiting(outboxId: string): Promise<boolean> {
    const row = await db
      .select()
      .from(lessonRequestOutbox)
      .where(eq(lessonRequestOutbox.id, outboxId))
      .get();
    return row?.status === "pending";
  }

  async function failedEmailJobs() {
    const failed = [];
    for (let offset = 0; ; offset += FAILED_JOB_PAGE_SIZE) {
      const page = await queue.list({
        status: "failed",
        queue: QUEUE_NAME,
        limit: FAILED_JOB_PAGE_SIZE,
        offset,
      });
      failed.push(...page.filter((job) => job.name === JOB_NAME));
      if (page.length < FAILED_JOB_PAGE_SIZE) return failed;
    }
  }

  return {
    async record(input) {
      const id = `lesson_request_${crypto.randomUUID()}`;
      const createdAt = nowIso();
      await db.batch([
        db.insert(lessonRequests).values({ id, ...input, createdAt }),
        db.insert(lessonRequestOutbox).values({
          id: `lesson_request_email_${crypto.randomUUID()}`,
          lessonRequestId: id,
          deliveryKey: deliveryKey(id),
          status: "pending",
          createdAt,
          updatedAt: createdAt,
          queuedAt: null,
          deliveredAt: null,
        }),
      ]);
      await this.requestSchedule();
      return id;
    },
    async requestSchedule() {
      try {
        await this.schedulePending();
      } catch (error) {
        try {
          options.onSchedulingError(error);
        } catch {
          // A broken observer must not change a stored request.
        }
      }
    },
    async schedulePending() {
      if (options.delivery === undefined) return 0;
      const pending = await db
        .select()
        .from(lessonRequestOutbox)
        .where(eq(lessonRequestOutbox.status, "pending"))
        .all();
      let scheduled = 0;
      for (const row of pending) {
        if (row.queuedAt !== null) continue;
        await queue.enqueue(JOB_NAME, { outboxId: row.id }, { maxAttempts: MAX_ATTEMPTS });
        const queuedAt = nowIso();
        await db
          .update(lessonRequestOutbox)
          .set({ queuedAt, updatedAt: queuedAt })
          .where(eq(lessonRequestOutbox.id, row.id))
          .run();
        scheduled += 1;
      }
      return scheduled;
    },
    async recoverFailed() {
      if (options.delivery === undefined) return 0;
      let recovered = 0;
      for (const job of await failedEmailJobs()) {
        const payload = outboxJobPayload.safeParse(job.payload);
        if (!payload.success || !(await isWaiting(payload.data.outboxId))) continue;
        if (await queue.retry(job.id)) recovered += 1;
      }
      return recovered;
    },
    runOnce: () => queue.runOnce({ queue: QUEUE_NAME, onJob: observeJob }),
    async drain() {
      let processed = 0;
      while ((await this.runOnce()) !== null) processed += 1;
      return processed;
    },
    async work(workOptions = {}) {
      if (options.delivery === undefined) return idleWorker;
      try {
        await this.recoverFailed();
      } catch (error) {
        try {
          options.onSchedulingError(error);
        } catch {
          // A broken observer must not stop the worker from starting.
        }
      }
      await this.schedulePending();
      return queue.work({
        ...workOptions,
        queue: QUEUE_NAME,
        onJob: (event) => {
          observeJob(event);
          workOptions.onJob?.(event);
        },
      });
    },
  };
}
