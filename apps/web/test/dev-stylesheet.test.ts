import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const READINESS_DEADLINE_MS = 30_000;

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no loopback port assigned"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForDevServer(
  baseUrl: string,
  server: ChildProcess,
  deadline = Date.now() + READINESS_DEADLINE_MS,
): Promise<void> {
  if (Date.now() >= deadline) throw new Error("lesto dev did not answer within 30 seconds");
  if (server.exitCode !== null) throw new Error(`lesto dev exited with ${server.exitCode}`);
  const status = await fetch(`${baseUrl}/api/dev/session`, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.status)
    .catch(() => null);
  if (status === 401) return;
  await sleep(200);
  await waitForDevServer(baseUrl, server, deadline);
}

async function expectCompiledStylesheet(url: URL, compiled: string): Promise<void> {
  const response = await fetch(url);
  expect({ path: url.pathname, status: response.status }).toEqual({
    path: url.pathname,
    status: 200,
  });
  expect(response.headers.get("content-type")).toMatch(/^text\/css\b/u);
  expect(await response.text()).toBe(compiled);
}

async function signIn(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/dev/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("development sign-in set no cookie");
  return cookie;
}

function stylesheetHrefs(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => /\brel=["']?stylesheet\b/iu.test(tag))
    .flatMap((tag) => {
      const href = /\bhref=["']([^"']+)["']/iu.exec(tag)?.[1];
      return href === undefined ? [] : [href];
    });
}

describe("lesto dev stylesheet", () => {
  let scratchDir = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "snackday-dev-stylesheet-"));
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("bun", ["--bun", "lesto", "dev", "--port", String(port)], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        LESTO_DB: join(scratchDir, "dev.db"),
        SNACKDAY_DEV_SIGN_IN: "true",
        SNACKDAY_RUNTIME_MODE: "development",
      },
      stdio: "ignore",
    });
    await waitForDevServer(baseUrl, server);
  }, READINESS_DEADLINE_MS + 5_000);

  afterAll(async () => {
    if (server !== undefined && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    await rm(scratchDir, { recursive: true, force: true });
  });

  it("serves the stylesheet linked from /app as the compiled CSS", async () => {
    const cookie = await signIn(baseUrl);
    const page = await fetch(`${baseUrl}/app`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const hrefs = stylesheetHrefs(await page.text());
    expect(hrefs.length).toBeGreaterThan(0);

    const compiled = await fetch(`${baseUrl}/styles.css`).then((response) => response.text());
    expect(compiled).toContain("tailwindcss");
    await Promise.all(
      hrefs.map((href) => expectCompiledStylesheet(new URL(href, `${baseUrl}/app`), compiled)),
    );
  });
});
