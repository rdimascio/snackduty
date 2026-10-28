import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { BlockedRequestError, createOfflineFetch } from "./support/offline-fetch";
import { startScenario, useScenario } from "./support/scenario";
import type { ScenarioSteps } from "./support/scenario";
import { openSession } from "./support/session";

setDefaultTimeout(60_000);

const OUTSIDE = "http://outside.invalid/landing";

function redirectServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/away") return Response.redirect(OUTSIDE, 302);
      if (pathname === "/hop") return Response.redirect("/home", 302);
      if (pathname === "/home") return new Response("home");
      return new Response("missing", { status: 404 });
    },
  });
}

describe("harness: a loopback URL that redirects outside fails the test", () => {
  const scenario = useScenario();
  let server: ReturnType<typeof redirectServer> | undefined;
  const origin = () => `http://127.0.0.1:${server?.port ?? 0}`;

  beforeAll(() => {
    server = redirectServer();
  });
  afterAll(async () => {
    await server?.stop(true);
  });

  test("the browser records the outside redirect hop as a problem", async () => {
    const session = await openSession(scenario(), "signed-out");
    const failed: string[] = [];
    session.page.on("requestfailed", (request) =>
      failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`),
    );
    try {
      await session.page.goto(`${origin()}/away`, { waitUntil: "commit" }).catch(() => null);
      await session.settle();
      expect(session.problems()).toContain(
        `blocked non-loopback redirect: ${origin()}/away -> ${OUTSIDE}`,
      );
      expect(failed).toEqual([`${OUTSIDE} net::ERR_PROXY_CONNECTION_FAILED`]);
    } finally {
      await session.close();
    }
  });

  test("the scenario server's fetch rejects a loopback redirect to an outside Location and logs it", async () => {
    const blocked: string[] = [];
    const offlineFetch = createOfflineFetch(globalThis.fetch, (url) => blocked.push(url));
    const failure = await offlineFetch(`${origin()}/away`).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BlockedRequestError);
    expect(blocked).toEqual([OUTSIDE]);
  });

  test("the scenario server's fetch still follows a loopback-to-loopback redirect", async () => {
    const blocked: string[] = [];
    const offlineFetch = createOfflineFetch(globalThis.fetch, (url) => blocked.push(url));
    const reply = await offlineFetch(`${origin()}/hop`);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe("home");
    expect(blocked).toEqual([]);
  });
});

function recordingSteps(fail: "boot" | "launch") {
  const seen = { scratch: "", stopped: false };
  const steps: ScenarioSteps = {
    seed: async (databasePath) => {
      seen.scratch = dirname(databasePath);
      await Bun.write(databasePath, "");
    },
    boot: () =>
      fail === "boot"
        ? Promise.reject(new Error("boot failed"))
        : Promise.resolve({
            port: 0,
            stop: () => {
              seen.stopped = true;
              return Promise.resolve();
            },
          }),
    launch: () => Promise.reject(new Error("launch failed")),
  };
  return { seen, steps };
}

describe("harness: startScenario cleans up when a start-up step fails", () => {
  test("a browser launch failure stops the server and removes the scratch directory", async () => {
    const { seen, steps } = recordingSteps("launch");
    await expect(startScenario({}, steps)).rejects.toThrow("launch failed");
    expect(seen.stopped).toBe(true);
    expect(seen.scratch).not.toBe("");
    expect(existsSync(seen.scratch)).toBe(false);
  });

  test("a server boot failure removes the scratch directory", async () => {
    const { seen, steps } = recordingSteps("boot");
    await expect(startScenario({}, steps)).rejects.toThrow("boot failed");
    expect(seen.scratch).not.toBe("");
    expect(existsSync(seen.scratch)).toBe(false);
  });
});
