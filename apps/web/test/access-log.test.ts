import { describe, expect, it } from "vitest";

import {
  logAccessLine,
  redactCredentialPath,
  redactingLogRequest,
} from "../app/lib/server/access-log";
import worker from "../worker";

// A realistic invitation token: the 32-byte hex `generateInviteToken` mints.
const TOKEN = "8bf4992a63d80243fd37c9da6451cd5dbdbc41bc2b34ba761dad6f93f04fa7a5";

describe("credential-path redaction", () => {
  it("replaces the invitation token segment", () => {
    expect(redactCredentialPath(`/invite/${TOKEN}`)).toBe("/invite/[redacted]");
  });

  it("redacts whatever shape the token segment has", () => {
    for (const token of ["x", "not-hex-at-all", "%2Fencoded%2F", "0123456789"]) {
      const redacted = redactCredentialPath(`/invite/${token}`);
      expect(redacted).toBe("/invite/[redacted]");
      expect(redacted).not.toContain(token);
    }
  });

  it("redacts on paths no route matches — the access log fires on 404s too", () => {
    expect(redactCredentialPath(`/invite/${TOKEN}/`)).toBe("/invite/[redacted]/");
    expect(redactCredentialPath(`/invite/${TOKEN}/accept`)).toBe("/invite/[redacted]/accept");
    expect(redactCredentialPath(`/INVITE/${TOKEN}`)).toBe("/INVITE/[redacted]");
  });

  // The calendar feed is the one credential that travels in a request line BY
  // DESIGN (calendar clients poll a plain GET URL — ADR 0009), so this entry
  // is the primary defence for a LIVE credential, not a legacy backstop.
  it("replaces the calendar feed token segment", () => {
    expect(redactCredentialPath(`/calendar/feed/${TOKEN}`)).toBe("/calendar/feed/[redacted]");
    expect(redactCredentialPath(`/calendar/feed/${TOKEN}/`)).toBe("/calendar/feed/[redacted]/");
    expect(redactCredentialPath(`/CALENDAR/Feed/${TOKEN}`)).toBe("/CALENDAR/Feed/[redacted]");
    for (const token of ["x", "not-hex-at-all", "%2Fencoded%2F"]) {
      expect(redactCredentialPath(`/calendar/feed/${token}`)).toBe("/calendar/feed/[redacted]");
    }
  });

  it("leaves every other path untouched", () => {
    for (const path of [
      "/",
      "",
      "/app",
      "/features",
      "/invite",
      "/invite/",
      "/calendar",
      "/calendar/feed",
      "/calendar/feed/",
      "/api/teams/team_123/invitations",
      "/api/teams/team_123/calendar-feed",
      "/api/invitations/accept",
      "/health",
    ]) {
      expect(redactCredentialPath(path)).toBe(path);
    }
  });
});

describe("the redacting access sink", () => {
  const entry = {
    method: "GET",
    path: `/invite/${TOKEN}`,
    status: 200,
    ms: 4,
    requestId: "req_1",
  };

  it("hands the sink a redacted path and keeps every other field", () => {
    const seen: unknown[] = [];
    redactingLogRequest((logged) => seen.push(logged))(entry);

    expect(seen).toEqual([{ ...entry, path: "/invite/[redacted]" }]);
  });

  it("passes an unaffected entry through unchanged", () => {
    const plain = { ...entry, path: "/app" };
    const seen: unknown[] = [];
    redactingLogRequest((logged) => seen.push(logged))(plain);

    expect(seen[0]).toBe(plain);
  });

  it("emits the structured access line both tiers log by default", async () => {
    const lines = await captureConsole(() => {
      redactingLogRequest(logAccessLine)(entry);
    });

    expect(JSON.parse(lines[0] ?? "null")).toEqual({
      level: "info",
      event: "http.access",
      method: "GET",
      path: "/invite/[redacted]",
      status: 200,
      ms: 4,
      request_id: "req_1",
    });
  });
});

/** Collect everything written to `console.log` while `run` executes. */
async function captureConsole(run: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }

  return lines;
}

// The edge Worker with a stub assets binding that always misses, so every
// request falls through to the app handler this app actually deploys.
const missingAssets = { fetch: () => Promise.resolve(new Response("", { status: 404 })) };
const executionContext = { waitUntil: () => Promise.resolve() };

async function edgeAccessLines(path: string): Promise<Record<string, unknown>[]> {
  const lines = await captureConsole(() =>
    worker.fetch(
      new Request(`https://snackday.test${path}`),
      { ASSETS: missingAssets },
      executionContext,
    ),
  );

  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the deployed edge handler", () => {
  // The live link shape is `/invite#<token>`: a fragment is never transmitted,
  // so this is what the edge receives for a real invitation — one log line
  // carrying no credential because no credential ever arrived.
  it("logs the invite page request, which carries no credential at all", async () => {
    const [access, ...rest] = await edgeAccessLines("/invite");

    expect(rest).toEqual([]);
    expect(access?.["event"]).toBe("http.access");
    expect(access?.["path"]).toBe("/invite");
    expect(access?.["status"]).toBe(200);
    // The line stays operationally useful: everything but the credential.
    expect(access?.["method"]).toBe("GET");
    expect(typeof access?.["ms"]).toBe("number");
    expect(typeof access?.["request_id"]).toBe("string");
  });

  // A legacy-shaped link — already delivered, bookmarked, or scanner-rewritten
  // — no longer routes, but the access log still fires, so the seam still has
  // to redact it.
  it("logs a legacy path-shaped invite request with the token redacted", async () => {
    const [access, ...rest] = await edgeAccessLines(`/invite/${TOKEN}`);

    expect(rest).toEqual([]);
    expect(access?.["event"]).toBe("http.access");
    expect(access?.["path"]).toBe("/invite/[redacted]");
    expect(access?.["status"]).toBe(404);
    expect(JSON.stringify(access)).not.toContain(TOKEN);
  });

  it("redacts even when no route matches — the log fires on the 404 too", async () => {
    const [access] = await edgeAccessLines(`/invite/${TOKEN}/accept`);

    expect(access?.["path"]).toBe("/invite/[redacted]/accept");
    expect(access?.["status"]).toBe(404);
    expect(JSON.stringify(access)).not.toContain(TOKEN);
  });

  it("logs every other path verbatim", async () => {
    const [access] = await edgeAccessLines("/features");

    expect(access?.["path"]).toBe("/features");
    expect(access?.["status"]).toBe(200);
  });

  // The DB-less Worker serves no feed, but a live feed URL pasted at the edge
  // still hits the access log — with the credential already gone.
  it("redacts a calendar feed poll that reaches the edge", async () => {
    const [access, ...rest] = await edgeAccessLines(`/calendar/feed/${TOKEN}`);

    expect(rest).toEqual([]);
    expect(access?.["path"]).toBe("/calendar/feed/[redacted]");
    expect(access?.["status"]).toBe(404);
    expect(JSON.stringify(access)).not.toContain(TOKEN);
  });
});
