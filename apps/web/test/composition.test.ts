import { createApp } from "@lesto/kernel";
import { describe, expect, it } from "vitest";
import { testApplication } from "./support/application";
import { buildApp } from "../app/lib/server/composition";

describe("isolated application composition", () => {
  it("refuses invitation delivery without persisted intent even in development", async () => {
    const isolated = await testApplication();
    const app = await createApp({
      ...isolated.default,
      app: buildApp(isolated.services.db, isolated.services.sessions, true),
    });
    const signIn = await app.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(signIn.status).toBe(200);
    const header = signIn.headers["Set-Cookie"];
    const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
    const response = await app.handle("POST", "/api/teams/absent/invitations", {
      headers: { "sec-fetch-site": "same-origin", cookie },
      body: {
        invitedRole: "adult",
        inviteeLabel: "Adult",
        recipientBinding: { kind: "verified_email", email: "adult@example.test" },
      },
    });
    expect(response.status).toBe(503);
    expect(await isolated.default.db.prepare("SELECT id FROM invitations").all()).toEqual([]);
  });
  it("does not share sessions or data between two live app instances", async () => {
    const first = await testApplication();
    const second = await testApplication();
    const a = await createApp(first.default);
    const b = await createApp(second.default);
    const signIn = await a.handle("POST", "/api/dev/sign-in", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(signIn.status).toBe(200);
    const header = signIn.headers["Set-Cookie"];
    const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
    expect(cookie.length).toBeGreaterThan(0);
    expect((await a.handle("GET", "/api/dev/session", { headers: { cookie } })).status).toBe(200);
    expect((await b.handle("GET", "/api/dev/session", { headers: { cookie } })).status).toBe(401);
  });
});
