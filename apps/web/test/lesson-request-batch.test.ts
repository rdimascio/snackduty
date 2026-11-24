import { createApp } from "@lesto/kernel";
import { installSchema as installQueueSchema } from "@lesto/queue";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import { describe, expect, it } from "vitest";

import { createLessonRequestOperations, createLessonRequests } from "../app/coach/lesson-requests";
import type { LessonRequestInput } from "../app/coach/booking-form";

const OUTBOX_FAILURE = "lesson request outbox insert refused";

const REQUEST: LessonRequestInput = {
  parentName: "Pat Parent",
  parentEmail: "pat.parent@example.test",
  phone: null,
  playerAge: 9,
  lessonType: "small-group",
  city: "Irvine",
  preferredTimes: "Weekday evenings",
  notes: null,
};

async function openLessonRequests() {
  const opened = await openSqlite(":memory:");
  await createApp({
    db: opened.db,
    app: lesto(),
    secure: false,
    migrations: [createLessonRequests],
    schemas: [installQueueSchema],
  });
  const operations = createLessonRequestOperations({
    sql: opened.db,
    onSchedulingError: () => {},
  });
  return { ...opened, operations };
}

async function rowCount(sql: Awaited<ReturnType<typeof openSqlite>>["db"], table: string) {
  const row = (await sql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()) as {
    count: number;
  };
  return row.count;
}

describe("lesson request batch", () => {
  it("stores the request and its outbox row together", async () => {
    const opened = await openLessonRequests();

    await opened.operations.record(REQUEST);

    expect(await rowCount(opened.db, "lesson_requests")).toBe(1);
    expect(await rowCount(opened.db, "lesson_request_outbox")).toBe(1);
    opened.close();
  });

  it("leaves no request row when the outbox insert fails", async () => {
    const opened = await openLessonRequests();
    await opened.db.exec(
      `CREATE TRIGGER refuse_lesson_request_outbox BEFORE INSERT ON lesson_request_outbox
       BEGIN SELECT RAISE(ABORT, '${OUTBOX_FAILURE}'); END`,
    );

    await expect(opened.operations.record(REQUEST)).rejects.toThrow(OUTBOX_FAILURE);

    expect(await rowCount(opened.db, "lesson_requests")).toBe(0);
    expect(await rowCount(opened.db, "lesson_request_outbox")).toBe(0);
    opened.close();
  });
});
