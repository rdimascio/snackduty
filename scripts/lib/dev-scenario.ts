import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import { redactAcceptanceLog } from "./acceptance-evidence";
import { DevScenarioApi, devScenarioError, isDevScenarioError } from "./dev-scenario-api";
import { seedDatabase } from "../../apps/web/app/dev/seed-database";
import { scenarioManifest, verifySeededScenario } from "./dev-scenario-roles";
import type { DevScenarioManifest } from "./dev-scenario-roles";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface WebServer {
  readonly process: Subprocess;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

export interface RunningDevScenario {
  readonly manifest: DevScenarioManifest;
  readonly readyInMs: number;
  stop(): Promise<void>;
  waitForServerExit(): Promise<number>;
}

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => {
        if (error !== undefined) return reject(error);
        if (address === null || typeof address === "string" || address.port < 1) {
          return reject(devScenarioError("reserve-port", "the OS did not assign a loopback port"));
        }
        resolve(address.port);
      });
    });
  });
}

export interface DevScenarioOptions {
  readonly signal?: AbortSignal;
  readonly serverEnv?: Readonly<Record<string, string>>;
}

function bootWebServer(
  port: number,
  databasePath: string,
  scratchDir: string,
  serverEnv: Readonly<Record<string, string>> = {},
): WebServer {
  const stdoutLog = join(scratchDir, "web.stdout.log");
  const stderrLog = join(scratchDir, "web.stderr.log");
  const child = Bun.spawn({
    cmd: ["bun", "--bun", "lesto", "dev", "--port", String(port)],
    cwd: join(ROOT, "apps", "web"),
    env: {
      ...process.env,
      LESTO_DB: databasePath,
      SNACKDAY_DEV_SIGN_IN: "true",
      SNACKDAY_LESSON_OF_THE_WEEK: "true",
      ...serverEnv,
    },
    stdout: Bun.file(stdoutLog),
    stderr: Bun.file(stderrLog),
  });
  return { process: child, stdoutLog, stderrLog };
}

async function stopWebServer(server: WebServer): Promise<void> {
  if (server.process.exitCode !== null || server.process.signalCode !== null) return;
  server.process.kill();
  const stopped = await Promise.race([
    server.process.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped) {
    server.process.kill(9);
    await server.process.exited;
  }
}

async function printFailureLogs(server: WebServer): Promise<void> {
  const logs = await Promise.all(
    [server.stdoutLog, server.stderrLog].map(async (path) => ({
      path,
      content: await readFile(path, "utf8").catch(() => ""),
    })),
  );
  for (const { path, content } of logs) {
    if (content.trim() !== "") {
      console.error(
        `${path} (tail):\n${redactAcceptanceLog(content.split("\n").slice(-25).join("\n"))}`,
      );
    }
  }
}

async function readinessAttempt(
  baseUrl: string,
  server: WebServer,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) {
    throw devScenarioError("server-readiness", "the web server did not answer within 30 seconds");
  }
  if (server.process.exitCode !== null) {
    throw devScenarioError(
      "server-readiness",
      `the web server exited early with code ${server.process.exitCode}`,
    );
  }
  try {
    const response = await fetch(`${baseUrl}/api/dev/session`, {
      signal:
        signal === undefined
          ? AbortSignal.timeout(2_000)
          : AbortSignal.any([AbortSignal.timeout(2_000), signal]),
    });
    if (response.status === 401) return;
    throw devScenarioError(
      "server-readiness",
      `GET /api/dev/session answered ${response.status}; expected 401`,
    );
  } catch (error) {
    if (isDevScenarioError(error)) throw error;
    signal?.throwIfAborted();
    await Bun.sleep(200);
    return readinessAttempt(baseUrl, server, deadline, signal);
  }
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

const APP_STYLESHEET_STEP = "app-stylesheet";

function scenarioRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(5_000);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

async function verifyStylesheetResponse(url: URL, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal: scenarioRequestSignal(signal) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (response.status !== 200) {
    throw devScenarioError(
      APP_STYLESHEET_STEP,
      `GET ${url.pathname} answered ${response.status}; expected 200`,
    );
  }
  if (!contentType.startsWith("text/css")) {
    throw devScenarioError(
      APP_STYLESHEET_STEP,
      `GET ${url.pathname} served ${contentType}; expected text/css`,
    );
  }
  if (body.trim() === "") {
    throw devScenarioError(APP_STYLESHEET_STEP, `GET ${url.pathname} served no CSS`);
  }
}

export async function verifyAppStylesheet(baseUrl: string, signal?: AbortSignal): Promise<void> {
  const { cookie } = await new DevScenarioApi(baseUrl, signal).signIn("default");
  const page = await fetch(`${baseUrl}/app`, {
    headers: { Cookie: cookie },
    signal: scenarioRequestSignal(signal),
  });
  if (page.status !== 200) {
    throw devScenarioError(APP_STYLESHEET_STEP, `GET /app answered ${page.status}; expected 200`);
  }
  const hrefs = stylesheetHrefs(await page.text());
  if (hrefs.length === 0)
    throw devScenarioError(APP_STYLESHEET_STEP, "GET /app links no stylesheet");
  await Promise.all(
    hrefs.map((href) => verifyStylesheetResponse(new URL(href, `${baseUrl}/app`), signal)),
  );
}

function waitForReadiness(baseUrl: string, server: WebServer, signal?: AbortSignal): Promise<void> {
  return readinessAttempt(baseUrl, server, Date.now() + 30_000, signal);
}

export async function startDevScenario(
  options: DevScenarioOptions = {},
): Promise<RunningDevScenario> {
  const startedAt = performance.now();
  options.signal?.throwIfAborted();
  const port = await reserveEphemeralPort();
  options.signal?.throwIfAborted();
  const scratchDir = await mkdtemp(join(tmpdir(), "snackduty-dev-scenario-"));
  const databasePath = join(scratchDir, "scenario.db");
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: WebServer;
  let seedFiles: string[];
  try {
    seedFiles = await seedDatabase(databasePath);
    server = bootWebServer(port, databasePath, scratchDir, options.serverEnv);
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopWebServer(server);
    await rm(scratchDir, { recursive: true, force: true });
  };

  try {
    options.signal?.throwIfAborted();
    await waitForReadiness(baseUrl, server, options.signal);
    const manifest = scenarioManifest(baseUrl, seedFiles);
    await verifySeededScenario(manifest, options.signal);
    await verifyAppStylesheet(baseUrl, options.signal);
    return {
      manifest,
      readyInMs: performance.now() - startedAt,
      stop,
      waitForServerExit: () => server.process.exited,
    };
  } catch (error) {
    try {
      if (!options.signal?.aborted) await printFailureLogs(server);
    } finally {
      await stop();
    }
    throw error;
  }
}

export async function checkDevScenario(
  options: Pick<DevScenarioOptions, "serverEnv"> = {},
): Promise<DevScenarioManifest> {
  const running = await startDevScenario(options);
  try {
    return running.manifest;
  } finally {
    await running.stop();
  }
}

function roleRows(manifest: DevScenarioManifest): string[] {
  const keyWidth = Math.max(...manifest.personas.map((persona) => persona.key.length));
  const roleWidth = Math.max(...manifest.personas.map((persona) => persona.role.length));
  return manifest.personas.map(
    (persona) =>
      `  ${persona.key.padEnd(keyWidth)}  ${persona.role.padEnd(roleWidth)}  ${persona.displayName} <${persona.email}>`,
  );
}

export function formatDevScenarioInstructions(
  manifest: DevScenarioManifest,
  readyInMs?: number,
): string {
  const { coached, second } = manifest.teams;
  return [
    readyInMs === undefined
      ? "Seeded development scenario is ready on loopback only."
      : `Seeded development scenario is ready on loopback only (${(readyInMs / 1_000).toFixed(1)}s).`,
    "",
    `Sign in as any role: ${manifest.signInPageUrl}`,
    `Web app: ${manifest.webBaseUrl}/app`,
    "",
    "Roles (persona key, role, adult):",
    ...roleRows(manifest),
    "",
    `Teams: ${coached.name} (${coached.teamId}) and ${second.name} (${second.teamId}), both "${coached.seasonLabel}".`,
    `Seed files applied after migrations: ${manifest.seedFiles.join(", ")}.`,
    `Calendar feed for Pat Parent: ${manifest.calendarFeedUrl}`,
    `Pending invitation for Sid Stranger: ${manifest.invitationUrls.stranger}`,
    "",
    'Sign in from a script: POST /api/dev/sign-in with {"persona": "<key>"}; no body signs in the default adult.',
    "Sign-in and the /dev/sign-in page exist only with SNACKDAY_DEV_SIGN_IN=true and never in production.",
    "",
    `Native simulator scheme environment: SNACKDAY_API_BASE_URL=${manifest.nativeApiBaseUrl} SNACKDAY_DEV_SIGN_IN=true`,
    `Native live tests: SNACKDAY_LIVE_API=${manifest.nativeApiBaseUrl} SNACKDAY_LIVE_UI_TEAM_ID=${second.teamId} bash scripts/ios-live-test.sh`,
    "",
    "Press Ctrl-C to stop the server and delete its temporary database.",
  ].join("\n");
}

export type { DevScenarioManifest } from "./dev-scenario-roles";
