import { createApp } from "@lesto/kernel";
import { describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";

const { default: config } = await import("./support/application").then((module) =>
  module.testApplication(),
);

const app = await createApp(config);

/**
 * The create-lesto starter ships a `posts` table, seed rows, and an
 * UNAUTHENTICATED `GET`/`POST /posts` pair registered inline in `lesto.app.ts`.
 * It survived every slice up to the first deploy conversation: an anonymous
 * write endpoint and "Hello, Lesto" content on the product origin, on a service
 * whose entire design is that child data is reachable only through one
 * authorization seam.
 *
 * These assertions are the tripwire for re-introducing it — by restoring the
 * starter, by scaffolding a new app from the template, or by adding any route
 * to `buildBaseApp`, which is the one surface in the app that no domain module
 * guards.
 */
describe("the create-lesto starter surface", () => {
  it("serves no unauthenticated posts API", async () => {
    const read = await app.handle("GET", "/posts", {});
    expect(read.status).toBe(404);

    const write = await app.handle("POST", "/posts", {
      headers: { "sec-fetch-site": "same-origin" },
      body: { title: "Injected", body: "Written with no session." },
    });
    // Anything but a 2xx keeps the data out; 404 is the house answer for a
    // route that does not exist.
    expect(write.status).toBe(404);
  });

  it("creates no posts table, so its migrations cannot seed starter content", async () => {
    expect(
      await config.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts'")
        .all(),
    ).toEqual([]);
  });
});
