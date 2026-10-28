import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll } from "bun:test";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

import { seedDatabase } from "../../apps/web/app/dev/seed-database";

const WEB_ROOT = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL("./offline-scenario-server.ts", import.meta.url));
const SERVER_READY_TIMEOUT_MS = 30_000;
const DATABASE_BUSY_TIMEOUT_MS = 5_000;

export const BALLPLAYER_HOST = "ballplayer.localhost";

export type Brand = "snackday" | "ballplayer";

export interface ScenarioOptions {
  readonly extraSql?: string;
}

export interface Scenario {
  readonly port: number;
  readonly databasePath: string;
  readonly browser: Browser;
  origin(brand?: Brand): string;
  query<T>(sql: string, ...params: (string | number | null)[]): T[];
  execute(sql: string): void;
  blockedRequests(): readonly string[];
  stop(): Promise<void>;
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

function readBlockedRequests(logPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { url: string }).url);
}

async function bootServer(databasePath: string, blockedLog: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, SERVER_ENTRY],
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      LESTO_DB: databasePath,
      E2E_BLOCKED_REQUESTS_LOG: blockedLog,
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
    Bun.sleep(SERVER_READY_TIMEOUT_MS).then(() => "timeout"),
  ]);
  const port = (JSON.parse(line.startsWith("{") ? line : "{}") as { port?: unknown }).port;
  if (typeof port !== "number") {
    await stop();
    throw new Error(`the scenario server did not report a port (${line})`);
  }
  return { port, stop };
}

export async function startScenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "snackday-e2e-"));
  const databasePath = join(scratch, "scenario.db");
  await seedDatabase(databasePath);
  const seeded = new Database(databasePath);
  try {
    if (options.extraSql !== undefined) seeded.exec(options.extraSql);
    seeded.exec("PRAGMA journal_mode = WAL");
  } finally {
    seeded.close();
  }
  const blockedLog = join(scratch, "blocked-requests.jsonl");
  const server = await bootServer(databasePath, blockedLog);
  const browser = await chromium.launch({ headless: true });
  const withDatabase = <T>(use: (database: Database) => T): T => {
    const database = new Database(databasePath);
    try {
      database.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
      return use(database);
    } finally {
      database.close();
    }
  };
  return {
    port: server.port,
    databasePath,
    browser,
    origin: (brand = "snackday") =>
      brand === "ballplayer"
        ? `http://${BALLPLAYER_HOST}:${server.port}`
        : `http://127.0.0.1:${server.port}`,
    query: <T>(sql: string, ...params: (string | number | null)[]) =>
      withDatabase((database) => database.query(sql).all(...params) as T[]),
    execute: (sql) => withDatabase((database) => database.exec(sql)),
    blockedRequests: () => readBlockedRequests(blockedLog),
    stop: async () => {
      await browser.close();
      await server.stop();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

export function useScenario(options: ScenarioOptions = {}): () => Scenario {
  let scenario: Scenario | undefined;
  beforeAll(async () => {
    scenario = await startScenario(options);
  });
  afterAll(async () => {
    await scenario?.stop();
    scenario = undefined;
  });
  return () => {
    if (scenario === undefined) throw new Error("the scenario is not running");
    return scenario;
  };
}
