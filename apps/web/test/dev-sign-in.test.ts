import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const [
  { buildApp, default: config },
  { DEV_ACCOUNT_ID, DEV_PERSON_ID, developmentIdentityServices },
] = await Promise.all([import("../lesto.app"), import("../app/lib/server/identity")]);

const app = await createApp(config);

async function clearIdentityState() {
  await config.db.exec(
    "DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearIdentityState);
afterAll(clearIdentityState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];

  if (Array.isArray(value)) return value[0] ?? "";

  return value ?? "";
}

describe("enabled development adult sign-in", () => {
  it("creates one fixed adult identity and authenticates its Account session", async () => {
    const signIn = await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(signIn.status).toBe(200);
    expect(json(signIn)).toEqual({
      account: { id: DEV_ACCOUNT_ID },
      person: { id: DEV_PERSON_ID, displayName: "Development Adult" },
    });

    const setCookie = header(signIn, "set-cookie");
    expect(setCookie).toContain("snackday_session_dev=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=86400");

    const cookiePair = setCookie.split(";", 1)[0] ?? "";
    const plaintextToken = cookiePair.slice(cookiePair.indexOf("=") + 1);
    const session = await app.handle("GET", "/api/dev/session", {
      headers: { cookie: cookiePair },
    });

    expect(session.status).toBe(200);
    expect(json(session)).toEqual(json(signIn));

    const storedSession = await config.db
      .prepare("SELECT token, user_id FROM lesto_sessions WHERE user_id = ? LIMIT 1")
      .get([DEV_ACCOUNT_ID]);
    expect(storedSession).toMatchObject({ user_id: DEV_ACCOUNT_ID });
    expect(storedSession).not.toMatchObject({ token: plaintextToken });

    const serialized = JSON.stringify(json(signIn)).toLowerCase();
    for (const forbidden of [
      "token",
      "email",
      "participant",
      "child",
      "household",
      "guardian",
      "birth",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("development adult identity constraints", () => {
  it("reuses the one fixed one-to-one Account and Person", async () => {
    await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(await config.db.prepare("SELECT id FROM people").all()).toEqual([{ id: DEV_PERSON_ID }]);
    expect(await config.db.prepare("SELECT id, person_id FROM accounts").all()).toEqual([
      { id: DEV_ACCOUNT_ID, person_id: DEV_PERSON_ID },
    ]);
  });

  it("keeps the existing same-origin protection", async () => {
    const response = await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
    expect(await config.db.prepare("SELECT id FROM accounts").all()).toEqual([]);
  });

  it("rejects arbitrary identity input", async () => {
    const response = await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
      body: { accountId: "attacker-selected-account" },
    });

    expect(response.status).toBe(400);
    expect(json(response)).toEqual({ error: "request body is not allowed" });
    expect(
      await config.db
        .prepare("SELECT id FROM accounts WHERE id = ?")
        .all(["attacker-selected-account"]),
    ).toEqual([]);
  });
});

describe("development session failures", () => {
  it.each([undefined, "snackday_session_dev=invalid-token"])(
    "returns one generic unauthorized response for a missing or invalid cookie",
    async (cookie) => {
      const response = await app.handle("GET", "/api/dev/session", {
        headers: cookie === undefined ? undefined : { cookie },
      });

      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    },
  );
});

describe("disabled development adult sign-in", () => {
  it("does not register either route", async () => {
    const services = await developmentIdentityServices(config.db);
    const disabled = buildApp(services.db, services.sessions, false);

    expect((await disabled.handle("POST", "/api/dev/sign-in")).status).toBe(404);
    expect((await disabled.handle("GET", "/api/dev/session")).status).toBe(404);
  });
});
