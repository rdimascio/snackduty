import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { lessonRequestSchema } from "../app/coach/booking-form";
import { PermanentEmailError, recordingEmailTransport } from "../app/lib/server/email";
import type { EmailTransport } from "../app/lib/server/email";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeApplication } from "../runtime";
import type { RuntimeConfiguration } from "../runtime/config";

const COACH_EMAIL = "coach@example.test";
const START = Date.parse("2026-11-22T18:00:00.000Z");

const REQUEST = lessonRequestSchema.parse({
  parentName: "Pat Parent",
  parentEmail: "pat.parent@example.test",
  phone: "(555) 010-0199",
  playerAge: "9",
  lessonType: "small-group",
  city: "Irvine",
  preferredTimes: "Weekday evenings",
  notes: "Gate code 4412",
});

const PERSONAL_VALUES = [
  REQUEST.parentName,
  REQUEST.parentEmail,
  REQUEST.phone ?? "",
  REQUEST.city,
  REQUEST.preferredTimes,
  REQUEST.notes ?? "",
];

function expectNoPersonalData(lines: readonly string[]): void {
  for (const line of lines) {
    for (const value of PERSONAL_VALUES) {
      expect({ line, leaked: line.includes(value) }).toEqual({ line, leaked: false });
    }
  }
}

function expectFailureLine(lines: readonly string[]): void {
  const failure = lines.find((line) => line.includes("lesson_request.delivery_failed"));
  expect(failure).toBeDefined();
  expect(Object.keys(JSON.parse(failure ?? "{}")).toSorted()).toEqual(["event", "job_id", "level"]);
}

function countingTransport(
  inner: EmailTransport,
): EmailTransport & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    send(message) {
      calls += 1;
      return inner.send(message);
    },
  };
}

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "snackday-coach-lost-leads-"));
  directories.push(directory);
  return join(directory, "runtime.db");
}

function configuration(path: string): RuntimeConfiguration {
  return {
    mode: "staging",
    databasePath: path,
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL("https://staging.snackduty.test"),
    upstreamCredentialPathLoggingSafe: false,
    coachRequestTo: COACH_EMAIL,
  } as RuntimeConfiguration;
}

function boot(path: string, transport: EmailTransport): Promise<RuntimeApplication> {
  return openRuntimeApplication(configuration(path), {
    clock: () => START,
    emailTransport: transport,
  });
}

async function outboxStatuses(runtime: RuntimeApplication): Promise<string[]> {
  const rows = (await runtime.sql.prepare("SELECT status FROM lesson_request_outbox").all()) as {
    status: string;
  }[];
  return rows.map((row) => row.status);
}

const rejecting: EmailTransport = {
  send: () => Promise.reject(new PermanentEmailError("sender not verified")),
};

describe("a lesson request whose email failed for good", () => {
  it("is logged without personal data and delivered after the next boot", async () => {
    const path = await databasePath();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await boot(path, rejecting);
    try {
      await broken.lessonRequests.record(REQUEST);
      expect((await broken.lessonRequests.runOnce())?.outcome).toBe("failed");
      expect(await outboxStatuses(broken)).toEqual(["pending"]);
    } finally {
      await broken.close();
    }
    const logged = errors.mock.calls.map(([line]) => String(line));
    errors.mockRestore();
    expectFailureLine(logged);
    expectNoPersonalData(logged);

    const recorder = recordingEmailTransport();
    const counted = countingTransport(recorder);
    const fixed = await boot(path, counted);
    try {
      const worker = await fixed.lessonRequests.work({ pollMs: 10 });
      await worker.stop();
      await fixed.lessonRequests.drain();

      expect(counted.calls()).toBe(1);
      expect(recorder.messages).toHaveLength(1);
      expect(recorder.messages[0]?.to).toBe(COACH_EMAIL);
      expect(recorder.messages[0]?.idempotencyKey).toMatch(/^lesson-request:lesson_request_/u);
      expect(await outboxStatuses(fixed)).toEqual(["delivered"]);
      expect(await fixed.lessonRequests.recoverFailed()).toBe(0);
    } finally {
      await fixed.close();
    }
  });

  it("logs the final failure from the running worker, the production path", async () => {
    const path = await databasePath();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = await boot(path, rejecting);
    try {
      await runtime.lessonRequests.record(REQUEST);
      let failed: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        failed = resolve;
      });
      const worker = await runtime.lessonRequests.work({
        pollMs: 10,
        onJob: (event) => {
          if (event.outcome === "failed") failed();
        },
      });
      await finished;
      await worker.stop();

      const logged = errors.mock.calls.map(([line]) => String(line));
      expectFailureLine(logged);
      expectNoPersonalData(logged);
    } finally {
      await runtime.close();
      errors.mockRestore();
    }
  });

  it("still starts the worker when a failed job's payload is corrupt", async () => {
    const path = await databasePath();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await boot(path, rejecting);
    try {
      await broken.lessonRequests.record(REQUEST);
      expect((await broken.lessonRequests.runOnce())?.outcome).toBe("failed");
      await broken.sql.prepare("UPDATE lesto_jobs SET payload = '{not json'").run();
    } finally {
      await broken.close();
    }

    const fixed = await boot(path, recordingEmailTransport());
    try {
      const worker = await fixed.lessonRequests.work({ pollMs: 10 });
      await worker.stop();

      const logged = errors.mock.calls.map(([line]) => String(line));
      expect(logged.some((line) => line.includes("lesson_request.scheduling_failed"))).toBe(true);
    } finally {
      await fixed.close();
      errors.mockRestore();
    }
  });

  it("does not re-queue a failed job whose request no longer waits", async () => {
    const path = await databasePath();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = await boot(path, rejecting);
    try {
      await runtime.lessonRequests.record(REQUEST);
      expect((await runtime.lessonRequests.runOnce())?.outcome).toBe("failed");
      await runtime.sql.prepare("UPDATE lesson_request_outbox SET status = 'cancelled'").run();

      expect(await runtime.lessonRequests.recoverFailed()).toBe(0);
      expect(await runtime.lessonRequests.runOnce()).toBeNull();
    } finally {
      await runtime.close();
      errors.mockRestore();
    }
  });
});
