#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  SNACKDAY_CONTENT_SECURITY_POLICY,
} from "../apps/web/app/server/content-security-policy";
import { seedDevScenario } from "./lib/dev-scenario-seed";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_ROOT = join(ROOT, "apps", "web");
const SERVER_ENTRY = join(WEB_ROOT, "test", "support", "csp-scenario-server.ts");
const VIOLATION_EVENT = "snackday-csp-violation";
const SETTLE_MS = 1_000;
const POSTER_TIMEOUT_MS = 15_000;
const POSTER_SELECTOR = 'section[aria-label="Lesson of the week"] img';

type Persona = "default" | "second-adult";

interface Visit {
  readonly label: string;
  readonly origin: "snackday" | "ballplayer";
  readonly path: string;
  readonly persona?: Persona;
  readonly expectStatus: number;
  readonly check?: (page: Page) => Promise<void>;
}

interface Running {
  readonly port: number;
  stop(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({ cmd, cwd, stdout: "ignore", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) fail(`${cmd.join(" ")} exited with code ${code}`);
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      reader.releaseLock();
      return text.slice(0, newline);
    }
  }
}

async function startServer(scratch: string): Promise<Running> {
  const child = Bun.spawn({
    cmd: ["bun", SERVER_ENTRY],
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      LESTO_DB: join(scratch, "scenario.db"),
      SNACKDAY_DEV_SIGN_IN: "true",
      SNACKDAY_LESSON_OF_THE_WEEK: "true",
      SNACKDAY_RUNTIME_MODE: "development",
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await child.exited;
  };
  const line = await Promise.race([
    firstLine(child.stdout),
    Bun.sleep(30_000).then(() => "timeout"),
  ]);
  const port = (JSON.parse(line.startsWith("{") ? line : "{}") as { port?: unknown }).port;
  if (typeof port !== "number") {
    await stop();
    fail(`the scenario server did not report a port (${line})`);
  }
  return { port, stop };
}

async function expectVisible(page: Page, selector: string, what: string): Promise<void> {
  const count = await page.locator(selector).count();
  if (count === 0) fail(`${what} is missing (${selector})`);
}

async function expectPosterLoaded(page: Page): Promise<void> {
  await page.locator(POSTER_SELECTOR).first().scrollIntoViewIfNeeded();
  await page
    .waitForFunction(
      (selector) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return image !== null && image.complete && image.naturalWidth > 0;
      },
      POSTER_SELECTOR,
      { timeout: POSTER_TIMEOUT_MS },
    )
    .catch(() => fail("the lesson poster did not load"));
}

async function expectLayoutWrapper(page: Page): Promise<void> {
  const wrapper = await page.evaluate(() => {
    const element = document.querySelector("[data-lesto-layout]");
    return element === null
      ? undefined
      : { display: getComputedStyle(element).display, style: element.getAttribute("style") };
  });
  if (wrapper === undefined) fail("the page has no Lesto layout wrapper");
  if (wrapper.display !== "contents") fail(`the layout wrapper renders as ${wrapper.display}`);
  if (wrapper.style !== null) fail("the layout wrapper still carries an inline style attribute");
}

async function expectAnswerHydrates(page: Page): Promise<void> {
  const choice = page.locator('section[aria-label="Lesson of the week"] button[type="button"]');
  await choice.first().click();
  await page.waitForSelector(
    'section[aria-label="Lesson of the week"] button[aria-pressed="true"]',
    { timeout: 5_000 },
  );
}

async function checkAppOverview(page: Page, persona: Persona): Promise<void> {
  await expectLayoutWrapper(page);
  await expectVisible(page, 'section[aria-label="Lesson of the week"]', "the lesson card");
  await expectVisible(page, 'section[aria-label="Player card"]', "the player card section");
  await expectVisible(page, "[data-lesto-island]", "an island");
  await expectPosterLoaded(page);
  if (persona === "second-adult") await expectAnswerHydrates(page);
}

const VISITS: readonly Visit[] = [
  { label: "Snackday home", origin: "snackday", path: "/", expectStatus: 200 },
  { label: "Snackday features", origin: "snackday", path: "/features", expectStatus: 200 },
  {
    label: "/app as coach and parent",
    origin: "snackday",
    path: "/app",
    persona: "second-adult",
    expectStatus: 200,
    check: (page) => checkAppOverview(page, "second-adult"),
  },
  {
    label: "/app as owner coach",
    origin: "snackday",
    path: "/app",
    persona: "default",
    expectStatus: 200,
    check: (page) => checkAppOverview(page, "default"),
  },
  { label: "invite landing", origin: "snackday", path: "/invite#not-a-token", expectStatus: 200 },
  { label: "Ballplayer home", origin: "ballplayer", path: "/", expectStatus: 200 },
];

function baseUrlFor(origin: Visit["origin"], port: number): string {
  return origin === "ballplayer"
    ? `http://ballplayer.localhost:${port}`
    : `http://127.0.0.1:${port}`;
}

async function signIn(page: Page, baseUrl: string, persona: Persona): Promise<void> {
  await page.goto(`${baseUrl}/`);
  const status = await page.evaluate(async (key) => {
    const response = await fetch("/api/dev/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: key }),
    });
    return response.status;
  }, persona);
  if (status !== 200) fail(`dev sign-in as ${persona} answered ${status}`);
}

async function visit(browser: Browser, port: number, target: Visit): Promise<string[]> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];
  await page.exposeFunction(VIOLATION_EVENT, (detail: string) => {
    problems.push(`violation ${detail}`);
  });
  await page.addInitScript((event) => {
    document.addEventListener("securitypolicyviolation", (violation) => {
      const report = (window as unknown as Record<string, (detail: string) => void>)[event];
      report?.(
        `${violation.effectiveDirective} blocked ${violation.blockedURI} at ${violation.sourceFile}:${violation.lineNumber}`,
      );
    });
  }, VIOLATION_EVENT);
  page.on("console", (message) => {
    if (/content security policy/iu.test(message.text())) {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  try {
    const baseUrl = baseUrlFor(target.origin, port);
    if (target.persona !== undefined) await signIn(page, baseUrl, target.persona);
    const response = await page.goto(`${baseUrl}${target.path}`, { waitUntil: "load" });
    if (response === null) fail("no response");
    if (response.status() !== target.expectStatus) {
      fail(`answered ${response.status()}; expected ${target.expectStatus}`);
    }
    const expectedPolicy =
      target.origin === "ballplayer"
        ? BALLPLAYER_CONTENT_SECURITY_POLICY
        : SNACKDAY_CONTENT_SECURITY_POLICY;
    const policy = response.headers()["content-security-policy"];
    if (policy !== expectedPolicy) fail(`carries policy ${String(policy)}`);
    await target.check?.(page);
    await page.waitForTimeout(SETTLE_MS);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
  return problems;
}

async function main(): Promise<void> {
  await run(["bun", "--bun", "lesto", "build"], WEB_ROOT);
  const scratch = await mkdtemp(join(tmpdir(), "snackday-csp-browser-"));
  let server: Running | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer(scratch);
    const seeded = await seedDevScenario(`http://127.0.0.1:${server.port}`);
    await seeded.verify();
    browser = await chromium.launch({ headless: true });
    let failures = 0;
    for (const target of VISITS) {
      const problems = await visit(browser, server.port, target);
      failures += problems.length;
      console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${target.label}`);
      for (const problem of problems) console.log(`     ${problem}`);
    }
    if (failures > 0) fail(`${failures} problem(s) found`);
    console.log("CSP browser check passed: zero violations.");
  } finally {
    await browser?.close();
    await server?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "CSP browser check failed");
  process.exitCode = 1;
}
