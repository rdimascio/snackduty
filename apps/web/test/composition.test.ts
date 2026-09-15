import { createApp } from "@lesto/kernel";
import { describe, expect, it } from "vitest";
import { testApplication } from "./support/application";

describe("isolated application composition", () => {
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
