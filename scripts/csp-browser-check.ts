#!/usr/bin/env bun

import { createHash } from "node:crypto";
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
import {
  DevScenarioEventApi,
  GAME_DUTIES,
  PRACTICE_TITLE,
  SCENARIO_GAMES,
} from "./lib/dev-scenario-events";
import { seedDevScenario } from "./lib/dev-scenario-seed";
import type { SeededDevScenario } from "./lib/dev-scenario-seed";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_ROOT = join(ROOT, "apps", "web");
const SERVER_ENTRY = join(WEB_ROOT, "test", "support", "csp-scenario-server.ts");
const VIOLATION_EVENT = "snackday-csp-violation";
const LESTO_LAYOUT_STYLE = "display:contents";
const LESTO_LAYOUT_STYLE_HASH = `'sha256-${createHash("sha256").update(LESTO_LAYOUT_STYLE).digest("base64")}'`;
const SETTLE_MS = 1_000;
const POSTER_TIMEOUT_MS = 15_000;
const POSTER_SELECTOR = 'section[aria-label="Lesson of the week"] img';
const REACT_PROGRESSIVE_CHUNK_SIZE = 12_800;
const LARGE_ROSTER_SIZE = 60;
const LARGE_ROSTER_BIRTH_DATE = "2018-06-01";

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
  const wrappers = await page.evaluate(() =>
    [...document.querySelectorAll("[data-lesto-layout]")].map(
      (element) => getComputedStyle(element).display,
    ),
  );
  if (wrappers.length === 0) fail("the page has no Lesto layout wrapper");
  for (const display of wrappers) {
    if (display !== "contents") fail(`a layout wrapper renders as ${display}`);
  }
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

function largeRosterPlayer(index: number): string {
  return `Roster Load ${String(index + 1).padStart(3, "0")}`;
}

async function seedLargeRoster(baseUrl: string, seeded: SeededDevScenario): Promise<void> {
  const api = new DevScenarioEventApi(baseUrl);
  const owner = await api.signIn("default");
  const { teamId, seasonId } = seeded.manifest.teams.coached;
  for (let index = 0; index < LARGE_ROSTER_SIZE; index += 1) {
    await api.addPlayer(owner.cookie, teamId, seasonId, {
      displayName: largeRosterPlayer(index),
      birthDate: LARGE_ROSTER_BIRTH_DATE,
    });
  }
}

async function checkLargeRoster(page: Page): Promise<void> {
  await expectLayoutWrapper(page);
  const skeletons = await page.locator('main [aria-busy="true"]').count();
  if (skeletons > 0) fail("the page is stuck on its loading skeleton");
  const routeBytes = await page.evaluate(
    () => document.querySelector("main")?.innerHTML.length ?? 0,
  );
  if (routeBytes <= REACT_PROGRESSIVE_CHUNK_SIZE) {
    fail(
      `the route content is ${routeBytes} bytes; it must exceed ${REACT_PROGRESSIVE_CHUNK_SIZE}`,
    );
  }
  const roster = page.locator('section[aria-label="Roster"]');
  for (let index = 0; index < LARGE_ROSTER_SIZE; index += 1) {
    const name = largeRosterPlayer(index);
    if ((await roster.getByText(name, { exact: true }).count()) === 0) {
      fail(`the roster is missing ${name}`);
    }
  }
  if (
    !(await roster
      .getByText(largeRosterPlayer(LARGE_ROSTER_SIZE - 1))
      .first()
      .isVisible())
  ) {
    fail("the last roster entry is not visible");
  }
}

async function expectText(page: Page, text: string, what: string): Promise<void> {
  if ((await page.getByText(text, { exact: false }).count()) === 0) fail(`${what} is missing`);
}

async function checkSchedule(page: Page): Promise<void> {
  await expectLayoutWrapper(page);
  await expectText(page, SCENARIO_GAMES[0]?.title ?? "", "the first seeded game");
  await expectText(page, PRACTICE_TITLE, "the practice series");
}

async function checkDuties(page: Page): Promise<void> {
  await expectLayoutWrapper(page);
  await expectVisible(page, "[data-lesto-island]", "the duties board island");
  for (const label of GAME_DUTIES) await expectText(page, label, `the ${label} duty slot`);
}

function seededPageVisits(persona: Persona, name: string): Visit[] {
  return [
    {
      label: `/app/schedule as ${name}`,
      origin: "snackday",
      path: "/app/schedule",
      persona,
      expectStatus: 200,
      check: checkSchedule,
    },
    {
      label: `/app/duties as ${name}`,
      origin: "snackday",
      path: "/app/duties",
      persona,
      expectStatus: 200,
      check: checkDuties,
    },
  ];
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
  ...seededPageVisits("default", "owner coach"),
  ...seededPageVisits("second-adult", "coach and parent"),
  {
    label: `/app as owner coach with a ${LARGE_ROSTER_SIZE}-player roster`,
    origin: "snackday",
    path: "/app",
    persona: "default",
    expectStatus: 200,
    check: checkLargeRoster,
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
  const blockedStyleMessages: string[] = [];
  let blockedLayoutStyles = 0;
  await page.exposeFunction(VIOLATION_EVENT, (detail: string, layoutWrapper: boolean) => {
    if (layoutWrapper) blockedLayoutStyles += 1;
    else problems.push(`violation ${detail}`);
  });
  await page.addInitScript(
    ({ event, layoutStyle }) => {
      document.addEventListener("securitypolicyviolation", (violation) => {
        const report = (
          window as unknown as Record<string, (detail: string, layoutWrapper: boolean) => void>
        )[event];
        const { target } = violation;
        const layoutWrapper =
          violation.effectiveDirective === "style-src-attr" &&
          target instanceof HTMLDivElement &&
          target.hasAttribute("data-lesto-layout") &&
          target.getAttribute("style") === layoutStyle;
        report?.(
          `${violation.effectiveDirective} blocked ${violation.blockedURI} at ${violation.sourceFile}:${violation.lineNumber}`,
          layoutWrapper,
        );
      });
    },
    { event: VIOLATION_EVENT, layoutStyle: LESTO_LAYOUT_STYLE },
  );
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes(LESTO_LAYOUT_STYLE_HASH)) blockedStyleMessages.push(text);
    else if (/content security policy/iu.test(text)) {
      problems.push(`console ${message.type()}: ${text}`);
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
    for (const text of blockedStyleMessages.slice(blockedLayoutStyles)) {
      problems.push(`console: ${text}`);
    }
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
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const seeded = await seedDevScenario(baseUrl);
    await seeded.verify();
    await seedLargeRoster(baseUrl, seeded);
    browser = await chromium.launch({ headless: true });
    let failures = 0;
    for (const target of VISITS) {
      const problems = await visit(browser, server.port, target);
      failures += problems.length;
      console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${target.label}`);
      for (const problem of problems) console.log(`     ${problem}`);
    }
    if (failures > 0) fail(`${failures} problem(s) found`);
    console.log("CSP browser check passed: no violation except the Lesto layout wrapper style.");
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
