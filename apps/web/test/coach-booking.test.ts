import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import type { AnyLestoResponse, HandleOptions } from "@lesto/web";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BOOKING_FIELDS, HONEYPOT_FIELD } from "../app/coach/booking-form";
import { COACH_BOOK_PATH, COACH_BOOK_SENT_PATH, lessonTypes } from "../app/coach/content";
import { LESSON_REQUEST_EMAIL_SUBJECT } from "../app/coach/lesson-requests";
import { recordingEmailTransport } from "../app/lib/server/email";
import type { EmailTransport, RecordingEmailTransport } from "../app/lib/server/email";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  COACH_CONTENT_SECURITY_POLICY,
  SNACKDAY_CONTENT_SECURITY_POLICY,
} from "../app/server/content-security-policy";
import { openRuntimeApplication, runtimeConfiguration } from "../runtime";
import type { RuntimeApplication, RuntimeConfiguration } from "../runtime";
import { registerRuntimePages } from "../runtime/web-surface";
import { findThirdPartyRisks, hasInlineScript, hasInlineStyle } from "./support/third-party";

const COACH_HOST = "dimasciobaseball.com";
const COACH_EMAIL = "coach@example.test";
const START = Date.parse("2026-11-22T18:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

const VALID_FORM = {
  parentName: "Pat Parent",
  parentEmail: "pat.parent@example.test",
  phone: "(555) 010-0199",
  playerAge: "9",
  lessonType: "small-group",
  city: "Irvine",
  preferredTimes: "Weekday evenings",
  notes: "Visit evil.example/login now",
};

const testDirectories: string[] = [];

const suiteDirectories: string[] = [];

async function removeAll(directories: string[]): Promise<void> {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
}

afterEach(async () => {
  await removeAll(testDirectories);
});

afterAll(async () => {
  await removeAll(suiteDirectories);
});

function headerNamed(response: AnyLestoResponse, name: string): string | string[] | undefined {
  return Object.entries(response.headers).find(([header]) => header.toLowerCase() === name)?.[1];
}

function policyOf(response: AnyLestoResponse): string | string[] | undefined {
  return headerNamed(response, "content-security-policy");
}

async function textOf(response: AnyLestoResponse): Promise<string> {
  const { body } = response;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

function postOptions(
  host: string,
  body: string,
  fetchSite: string | undefined = "same-origin",
): HandleOptions {
  return {
    headers: {
      host,
      "content-type": FORM_CONTENT_TYPE,
      ...(fetchSite === undefined ? {} : { "sec-fetch-site": fetchSite }),
    },
    body,
  };
}

async function configuration(
  directories: string[],
  extra: Partial<RuntimeConfiguration> = {},
): Promise<RuntimeConfiguration> {
  const directory = await mkdtemp(join(tmpdir(), "snackday-coach-booking-"));
  directories.push(directory);
  return {
    mode: "staging",
    databasePath: join(directory, "runtime.db"),
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL("https://staging.snackduty.test"),
    upstreamCredentialPathLoggingSafe: false,
    ...extra,
  } as RuntimeConfiguration;
}

interface OpenedRuntime {
  readonly runtime: RuntimeApplication;
  advance(milliseconds: number): void;
}

async function openRuntime(
  options: {
    readonly transport?: EmailTransport;
    readonly coachRequestTo?: string;
    readonly directories?: string[];
  } = {},
): Promise<OpenedRuntime> {
  let now = START;
  const runtime = await openRuntimeApplication(
    await configuration(
      options.directories ?? testDirectories,
      options.coachRequestTo === undefined ? {} : { coachRequestTo: options.coachRequestTo },
    ),
    {
      clock: () => now,
      ...(options.transport === undefined ? {} : { emailTransport: options.transport }),
    },
  );
  return {
    runtime,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

async function countRows(runtime: RuntimeApplication, table: string): Promise<number> {
  const rows = (await runtime.sql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).all()) as {
    count: number;
  }[];
  return Number(rows[0]?.count ?? 0);
}

async function outboxRows(runtime: RuntimeApplication) {
  return (await runtime.sql
    .prepare("SELECT status, queued_at, delivered_at FROM lesson_request_outbox")
    .all()) as { status: string; queued_at: string | null; delivered_at: string | null }[];
}

async function expectNothingStored(runtime: RuntimeApplication): Promise<void> {
  expect(await countRows(runtime, "lesson_requests")).toBe(0);
  expect(await countRows(runtime, "lesson_request_outbox")).toBe(0);
  expect(await countRows(runtime, "lesto_jobs")).toBe(0);
}

function submit(app: App, fields: Readonly<Record<string, string>>, fetchSite?: string) {
  return app.handle("POST", COACH_BOOK_PATH, postOptions(COACH_HOST, formBody(fields), fetchSite));
}

describe("the lesson request form on the coach host", () => {
  let opened: OpenedRuntime | undefined;
  let transport: RecordingEmailTransport;

  function runtime(): RuntimeApplication {
    if (opened === undefined) throw new Error("runtime did not open");
    return opened.runtime;
  }

  beforeAll(async () => {
    transport = recordingEmailTransport();
    opened = await openRuntime({
      transport,
      coachRequestTo: COACH_EMAIL,
      directories: suiteDirectories,
    });
  });

  afterAll(async () => {
    await opened?.runtime.close();
  });

  it("links the home page to the form", async () => {
    const home = await textOf(
      await runtime().app.handle("GET", "/", { headers: { host: COACH_HOST } }),
    );

    expect(home).toContain(`href="${COACH_BOOK_PATH}"`);
    expect(home).toContain("Request a lesson");
    expect(home).not.toContain("Booking opens soon");
  });

  it("renders the form with the coach policy and no script or inline style", async () => {
    const response = await runtime().app.handle("GET", COACH_BOOK_PATH, {
      headers: { host: COACH_HOST },
    });
    const html = await textOf(response);

    expect(response.status).toBe(200);
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(html).toContain(`action="${COACH_BOOK_PATH}"`);
    expect(html).toContain('method="post"');
    for (const field of BOOKING_FIELDS.filter((name) => name !== "lessonType")) {
      expect(html).toContain(`for="${field}"`);
      expect(html).toContain(`id="${field}"`);
    }
    for (const lesson of lessonTypes) {
      expect(html).toContain(`for="lessonType-${lesson.id}"`);
      expect(html).toContain(`value="${lesson.id}"`);
    }
    expect(html).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("/client.js");
    expect(hasInlineScript(html)).toBe(false);
    expect(hasInlineStyle(html)).toBe(false);
    expect(findThirdPartyRisks(html, "markup")).toEqual([]);
  });

  it("stores one request, queues one email and redirects to the sent page", async () => {
    const response = await submit(runtime().app, VALID_FORM);

    expect(response.status).toBe(303);
    expect(headerNamed(response, "location")).toBe(COACH_BOOK_SENT_PATH);
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(headerNamed(response, "cache-control")).toBe("private, no-store");
    expect(await countRows(runtime(), "lesson_requests")).toBe(1);
    expect(await countRows(runtime(), "lesto_jobs")).toBe(1);
    const [outbox] = await outboxRows(runtime());
    expect(outbox?.status).toBe("pending");
    expect(outbox?.queued_at).not.toBeNull();

    const stored = (await runtime().sql.prepare("SELECT * FROM lesson_requests").all()) as Record<
      string,
      unknown
    >[];
    expect(stored[0]).toMatchObject({
      parent_name: "Pat Parent",
      parent_email: "pat.parent@example.test",
      player_age: 9,
      lesson_type: "small-group",
    });
    expect(Object.keys(stored[0] ?? {})).not.toContain("player_name");

    const sent = await runtime().app.handle("GET", COACH_BOOK_SENT_PATH, {
      headers: { host: COACH_HOST },
    });
    expect(sent.status).toBe(200);
    expect(policyOf(sent)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(await textOf(sent)).toContain("Request sent");
  });

  it("sends the coach one email with every typed value quoted", async () => {
    expect(await runtime().lessonRequests.drain()).toBe(1);

    expect(transport.messages).toHaveLength(1);
    const [message] = transport.messages;
    expect(message?.to).toBe(COACH_EMAIL);
    expect(message?.subject).toBe(LESSON_REQUEST_EMAIL_SUBJECT);
    expect(message?.text).toContain('Parent: "Pat Parent"');
    expect(message?.text).toContain('Email: "pat.parent@example.test"');
    expect(message?.text).toContain("Lesson: Small group");
    expect(message?.text).toContain("Player age: 9");
    expect(message?.text).toContain('Notes: "Visit evil example login now"');
    expect(message?.text).not.toContain("evil.example/login");
    expect((await outboxRows(runtime()))[0]?.status).toBe("delivered");

    expect(await runtime().lessonRequests.schedulePending()).toBe(0);
    expect(await runtime().lessonRequests.drain()).toBe(0);
    expect(transport.messages).toHaveLength(1);
  });

  it("re-renders the form with the values and one error per field, and stores nothing new", async () => {
    const before = await countRows(runtime(), "lesson_requests");
    const response = await submit(runtime().app, {
      ...VALID_FORM,
      parentName: "",
      parentEmail: "not-an-email",
      playerAge: "40",
      lessonType: "hacking",
      city: "Irvine",
    });
    const html = await textOf(response);

    expect(response.status).toBe(422);
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(headerNamed(response, "cache-control")).toBe("private, no-store");
    expect(hasInlineScript(html)).toBe(false);
    expect(hasInlineStyle(html)).toBe(false);
    expect(html).toContain('value="not-an-email"');
    expect(html).toContain('value="Irvine"');
    expect(html).toContain("Visit evil.example/login now</textarea>");
    expect(html).toContain("Enter your name.");
    expect(html).toContain("Enter an email address like name@example.com.");
    expect(html).toContain("Enter an age from 4 to 18.");
    expect(html).toContain("Choose a lesson type.");
    expect(html.match(/id="parentEmail-error"/gu)).toHaveLength(1);
    expect(html).toContain('aria-invalid="true"');
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });

  it("caps every string", async () => {
    const before = await countRows(runtime(), "lesson_requests");
    const response = await submit(runtime().app, { ...VALID_FORM, notes: "a".repeat(501) });

    expect(response.status).toBe(422);
    expect(await textOf(response)).toContain("Use 500 characters or fewer.");
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });

  it("answers a filled honeypot with the sent page and stores nothing", async () => {
    const before = await countRows(runtime(), "lesson_requests");
    const response = await submit(runtime().app, {
      ...VALID_FORM,
      [HONEYPOT_FIELD]: "https://spam.example",
    });

    expect(response.status).toBe(303);
    expect(headerNamed(response, "location")).toBe(COACH_BOOK_SENT_PATH);
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });

  it("refuses a cross-site post", async () => {
    const before = await countRows(runtime(), "lesson_requests");
    const response = await submit(runtime().app, VALID_FORM, "cross-site");

    expect(response.status).toBe(403);
    expect(policyOf(response)).toBe(COACH_CONTENT_SECURITY_POLICY);
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });

  it("refuses a post that carries an Origin but no Sec-Fetch-Site", async () => {
    const before = await countRows(runtime(), "lesson_requests");
    const response = await runtime().app.handle("POST", COACH_BOOK_PATH, {
      headers: {
        host: COACH_HOST,
        origin: `https://${COACH_HOST}`,
        "content-type": FORM_CONTENT_TYPE,
      },
      body: formBody(VALID_FORM),
    });

    expect(response.status).toBe(403);
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });

  it("never forwards the internal re-render path", async () => {
    const response = await runtime().app.handle("GET", "/__coach/book-retry", {
      headers: { host: COACH_HOST },
    });

    expect(response.status).toBe(404);
  });

  it.each([
    ["snackday.test", SNACKDAY_CONTENT_SECURITY_POLICY],
    ["ballplayer.co", BALLPLAYER_CONTENT_SECURITY_POLICY],
  ])("answers the booking paths on %s with a 404", async (host, policy) => {
    const before = await countRows(runtime(), "lesson_requests");
    const responses = [
      await runtime().app.handle("GET", COACH_BOOK_PATH, { headers: { host } }),
      await runtime().app.handle("GET", COACH_BOOK_SENT_PATH, { headers: { host } }),
      await runtime().app.handle("POST", COACH_BOOK_PATH, postOptions(host, formBody(VALID_FORM))),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(policyOf(response)).toBe(policy);
    }
    expect(await countRows(runtime(), "lesson_requests")).toBe(before);
  });
});

describe("lesson request email delivery", () => {
  it("retries with the same idempotency key, so a lost reply sends no second email", async () => {
    const recorder = recordingEmailTransport();
    let calls = 0;
    const replyLostOnce: EmailTransport = {
      async send(message) {
        calls += 1;
        await recorder.send(message);
        if (calls === 1) throw new Error("connection reset");
      },
    };
    const { runtime, advance } = await openRuntime({
      transport: replyLostOnce,
      coachRequestTo: COACH_EMAIL,
    });
    try {
      expect((await submit(runtime.app, VALID_FORM)).status).toBe(303);

      expect((await runtime.lessonRequests.runOnce())?.outcome).toBe("retry");
      expect((await outboxRows(runtime))[0]?.status).toBe("pending");
      advance(HOUR_MS);
      expect((await runtime.lessonRequests.runOnce())?.outcome).toBe("done");

      expect(calls).toBe(2);
      expect(recorder.messages).toHaveLength(1);
      expect((await outboxRows(runtime))[0]?.status).toBe("delivered");
    } finally {
      await runtime.close();
    }
  });

  it("stores the request and waits when no coach address is set", async () => {
    const transport = recordingEmailTransport();
    const { runtime } = await openRuntime({ transport });
    try {
      const response = await submit(runtime.app, VALID_FORM);

      expect(response.status).toBe(303);
      expect(headerNamed(response, "location")).toBe(COACH_BOOK_SENT_PATH);
      expect(await countRows(runtime, "lesson_requests")).toBe(1);
      expect(await outboxRows(runtime)).toEqual([
        { status: "pending", queued_at: null, delivered_at: null },
      ]);
      expect(await countRows(runtime, "lesto_jobs")).toBe(0);
      expect(await runtime.lessonRequests.drain()).toBe(0);
      expect(transport.messages).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("stores the request and waits when no email transport is set", async () => {
    const { runtime } = await openRuntime({ coachRequestTo: COACH_EMAIL });
    try {
      expect((await submit(runtime.app, VALID_FORM)).status).toBe(303);
      expect(await countRows(runtime, "lesson_requests")).toBe(1);
      expect(await countRows(runtime, "lesto_jobs")).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("stores nothing for a post that fails validation", async () => {
    const { runtime } = await openRuntime({ coachRequestTo: COACH_EMAIL });
    try {
      expect((await submit(runtime.app, { ...VALID_FORM, parentEmail: "" })).status).toBe(422);
      await expectNothingStored(runtime);
    } finally {
      await runtime.close();
    }
  });
});

describe("SNACKDAY_COACH_REQUEST_TO", () => {
  const base = {
    SNACKDAY_RUNTIME_MODE: "staging",
    SNACKDAY_PUBLIC_BASE_URL: "https://staging.snackduty.test",
    LESTO_DB: "/var/lib/snackday/runtime.db",
  };

  it("reads one email address", () => {
    expect(
      runtimeConfiguration({ ...base, SNACKDAY_COACH_REQUEST_TO: COACH_EMAIL }).coachRequestTo,
    ).toBe(COACH_EMAIL);
    expect(runtimeConfiguration(base).coachRequestTo).toBeUndefined();
  });

  it("refuses a value that is not one email address", () => {
    for (const value of ["coach", "a@example.test, b@example.test", "coach@example.test\nBcc: x"]) {
      expect(() => runtimeConfiguration({ ...base, SNACKDAY_COACH_REQUEST_TO: value })).toThrow(
        "SNACKDAY_COACH_REQUEST_TO must be one email address.",
      );
    }
  });
});

describe("the lesson request form in dev (lesto.app.ts)", () => {
  let app: App | undefined;

  beforeAll(async () => {
    process.env["LESTO_DB"] = ":memory:";
    process.env["SNACKDAY_DEV_SIGN_IN"] = "true";
    const { default: applicationConfig } = await import("../lesto.app");
    const config = await applicationConfig();
    await registerRuntimePages(config.app);
    app = await createApp(config);
  });

  it("renders the form and stores a request on the dev host", async () => {
    if (app === undefined) throw new Error("dev app did not open");
    const form = await app.handle("GET", COACH_BOOK_PATH, {
      headers: { host: "coach.localhost:3000" },
    });
    expect(form.status).toBe(200);
    expect(policyOf(form)).toBe(COACH_CONTENT_SECURITY_POLICY);

    const response = await app.handle(
      "POST",
      COACH_BOOK_PATH,
      postOptions("coach.localhost:3000", formBody(VALID_FORM)),
    );
    expect(response.status).toBe(303);
    expect(headerNamed(response, "location")).toBe(COACH_BOOK_SENT_PATH);
  });
});
