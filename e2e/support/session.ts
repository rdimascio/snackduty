import { createHash } from "node:crypto";

import { expect } from "bun:test";
import type { BrowserContext, Page, Response } from "playwright-core";

import type { SeedPersonaKey } from "../../apps/web/app/dev/seed-personas";
import type { Brand, Scenario } from "./scenario";

export type Role = SeedPersonaKey | "signed-out";

const VIOLATION_BINDING = "snackdayE2eCspViolation";
const LESTO_LAYOUT_STYLE = "display:contents";
const LESTO_LAYOUT_STYLE_HASH = `sha256-${createHash("sha256").update(LESTO_LAYOUT_STYLE).digest("base64")}`;
const NEUTRAL_PATH = "/styles.css";
const FAILED_RESOURCE = /^Failed to load resource: the server responded with a status of (\d{3})/u;

export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface RoleSession {
  readonly role: Role;
  readonly brand: Brand;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly origin: string;
  open(path: string, expectedStatus?: number): Promise<Response>;
  reload(): Promise<Response>;
  api(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<ApiReply>;
  allowFailedResponse(status: number, path: string | RegExp): void;
  problems(): readonly string[];
  close(): Promise<void>;
}

interface AllowedFailure {
  readonly status: number;
  readonly path: string | RegExp;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function matches(allowed: AllowedFailure, status: number, url: string): boolean {
  if (allowed.status !== status) return false;
  const path = pathOf(url);
  return typeof allowed.path === "string"
    ? path === allowed.path || path.split("?")[0] === allowed.path
    : allowed.path.test(path);
}

export async function signIn(page: Page, origin: string, role: Role): Promise<void> {
  if (role === "signed-out") return;
  await page.goto(`${origin}${NEUTRAL_PATH}`, { waitUntil: "commit" });
  const status = await page.evaluate(async (persona) => {
    const response = await fetch("/api/dev/sign-in", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });
    return response.status;
  }, role);
  if (status !== 200) throw new Error(`dev sign-in as ${role} answered ${status}`);
}

export async function openSession(
  scenario: Scenario,
  role: Role,
  brand: Brand = "snackday",
): Promise<RoleSession> {
  const origin = scenario.origin(brand);
  const context = await scenario.browser.newContext({ baseURL: origin });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const found: string[] = [];
  const allowed: AllowedFailure[] = [];

  await page.exposeBinding(VIOLATION_BINDING, (_source, detail: string, layout: boolean) => {
    if (!layout) found.push(`CSP violation: ${detail}`);
  });
  await page.addInitScript(
    ({ binding, layoutStyle }) => {
      document.addEventListener("securitypolicyviolation", (violation) => {
        const report = (window as unknown as Record<string, (d: string, l: boolean) => void>)[
          binding
        ];
        const { target } = violation;
        const layout =
          violation.effectiveDirective === "style-src-attr" &&
          target instanceof HTMLDivElement &&
          target.hasAttribute("data-lesto-layout") &&
          target.getAttribute("style") === layoutStyle;
        report?.(
          `${violation.effectiveDirective} blocked ${violation.blockedURI} at ${violation.sourceFile}:${violation.lineNumber}`,
          layout,
        );
      });
    },
    { binding: VIOLATION_BINDING, layoutStyle: LESTO_LAYOUT_STYLE },
  );

  page.on("pageerror", (error) => found.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (text.includes(LESTO_LAYOUT_STYLE_HASH)) return;
    const failed = FAILED_RESOURCE.exec(text);
    if (failed !== null) {
      const status = Number(failed[1]);
      const url = message.location().url;
      if (allowed.some((entry) => matches(entry, status, url))) return;
      found.push(`console error: ${text} (${pathOf(url)})`);
      return;
    }
    if (message.type() === "error") found.push(`console error: ${text}`);
  });
  page.on("response", (response) => {
    if (response.status() === 429) found.push(`429 from ${pathOf(response.url())}`);
  });

  await signIn(page, origin, role);

  const session: RoleSession = {
    role,
    brand,
    context,
    page,
    origin,
    async open(path, expectedStatus = 200) {
      if (expectedStatus >= 400) allowed.push({ status: expectedStatus, path });
      const response = await page.goto(path, { waitUntil: "load" });
      if (response === null) throw new Error(`no response for ${path}`);
      expect(`${path} → ${response.status()}`).toBe(`${path} → ${expectedStatus}`);
      return response;
    },
    async reload() {
      const response = await page.reload({ waitUntil: "load" });
      if (response === null) throw new Error("no response for reload");
      return response;
    },
    async api(method, path, body) {
      if (!page.url().startsWith(origin)) await page.goto(NEUTRAL_PATH, { waitUntil: "commit" });
      return page.evaluate(
        async ({ method: verb, path: target, body: payload }) => {
          const response = await fetch(target, {
            method: verb,
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          return { status: response.status, body: parsed, text };
        },
        { method, path, body },
      );
    },
    allowFailedResponse(status, path) {
      allowed.push({ status, path });
    },
    problems: () => [...found],
    async close() {
      await context.close();
    },
  };
  return session;
}

export async function asRole(
  scenario: Scenario,
  role: Role,
  run: (session: RoleSession) => Promise<void>,
  brand: Brand = "snackday",
): Promise<void> {
  const session = await openSession(scenario, role, brand);
  try {
    await run(session);
    await session.page.waitForTimeout(150);
    expect(session.problems()).toEqual([]);
  } finally {
    await session.close();
  }
}

export async function refused(
  session: RoleSession,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  statuses: readonly number[] = [403, 404],
): Promise<ApiReply> {
  for (const status of statuses) session.allowFailedResponse(status, path);
  const reply = await session.api(method, path, body);
  expect(`${method} ${path} → ${reply.status}`).toBe(
    `${method} ${path} → ${statuses.includes(reply.status) ? reply.status : statuses.join("|")}`,
  );
  return reply;
}
