import { BROWSER_SPANS_PATH, startBrowserRum } from "@lesto/observability/rum";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PAGE_URL = "https://snackday.test/app";
const PAGE_LOAD_BATCHES = 2;
const FLUSH_SETTLE_MS = 250;
const QUIET_WINDOW_MS = 5_000;
const PAGE_RESOURCES = [
  { path: "/client.js", initiator: "script" },
  { path: "/styles.css", initiator: "link" },
  { path: "/docs/__lesto/browser-spans", initiator: "fetch" },
];

interface TimingEntry {
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly [field: string]: unknown;
}

interface SpanBatch {
  readonly spans: readonly {
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }[];
}

type ObserverCallback = (list: { getEntries(): TimingEntry[] }) => void;

interface Registration {
  readonly types: Set<string>;
  readonly callback: ObserverCallback;
}

function deliver(callback: ObserverCallback, entries: TimingEntry[]): void {
  setTimeout(() => callback({ getEntries: () => entries }), 0);
}

function resourceTimingBrowser() {
  const entries: TimingEntry[] = [];
  const registrations = new Set<Registration>();
  let clock = 0;

  function record(entry: TimingEntry): void {
    entries.push(entry);
    for (const registration of registrations) {
      if (registration.types.has(entry.entryType)) deliver(registration.callback, [entry]);
    }
  }

  function recordResource(url: string, initiatorType: string): void {
    clock += 5;
    record({
      entryType: "resource",
      name: new URL(url, PAGE_URL).href,
      initiatorType,
      startTime: clock,
      duration: 4,
    });
  }

  function PerformanceObserver(callback: ObserverCallback) {
    const registration: Registration = { types: new Set(), callback };
    return {
      observe(options: { type: string; buffered?: boolean }): void {
        registration.types.add(options.type);
        registrations.add(registration);
        const buffered = entries.filter((entry) => entry.entryType === options.type);
        if (options.buffered === true && buffered.length > 0) deliver(callback, buffered);
      },
      disconnect(): void {
        registrations.delete(registration);
      },
    };
  }

  return { record, recordResource, PerformanceObserver };
}

function navigationEntry(): TimingEntry {
  return {
    entryType: "navigation",
    name: PAGE_URL,
    startTime: 0,
    duration: 120,
    domainLookupStart: 1,
    domainLookupEnd: 2,
    connectStart: 2,
    secureConnectionStart: 3,
    connectEnd: 6,
    requestStart: 7,
    responseStart: 40,
    responseEnd: 60,
    domContentLoadedEventEnd: 90,
    loadEventEnd: 120,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSpanPost(input: unknown, init: RequestInit | undefined): boolean {
  const path = new URL(String(input), PAGE_URL).pathname;
  return init?.method === "POST" && path === BROWSER_SPANS_PATH;
}

const browser = resourceTimingBrowser();
const batches: SpanBatch[] = [];

async function pageFetch(input: unknown, init?: RequestInit): Promise<Response> {
  if (isSpanPost(input, init)) batches.push(JSON.parse(String(init?.body)) as SpanBatch);
  await Promise.resolve();
  browser.recordResource(String(input), "fetch");
  return new Response(null, { status: 204 });
}

describe("browser RUM beacon in a sampled tab", () => {
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  let window: import("happy-dom").Window;
  let stopRum: (() => void) | undefined;

  beforeAll(async () => {
    const { Window } = await import("happy-dom");
    window = new Window({ url: PAGE_URL });
    const globals = {
      window,
      document: window.document,
      location: window.location,
      PerformanceObserver: browser.PerformanceObserver,
      fetch: pageFetch,
    };
    for (const [key, value] of Object.entries(globals)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    browser.record(navigationEntry());
    for (const resource of PAGE_RESOURCES)
      browser.recordResource(resource.path, resource.initiator);
    stopRum = startBrowserRum({ sampleRate: 1 });
    await wait(FLUSH_SETTLE_MS);
  });

  afterAll(async () => {
    stopRum?.();
    await window.happyDOM.close();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });

  it("posts only the page load batches and stays quiet for five seconds", async () => {
    const afterFlush = batches.length;
    expect(afterFlush).toBeGreaterThan(0);
    expect(afterFlush).toBeLessThanOrEqual(PAGE_LOAD_BATCHES);
    await wait(QUIET_WINDOW_MS);
    expect(batches.length).toBe(afterFlush);
  }, 15_000);

  it("keeps every page span and drops only its own span endpoint", () => {
    const spans = batches.flatMap((batch) => batch.spans);
    const resourcePaths = spans
      .filter((span) => span.name === "browser.resource")
      .map((span) => span.attributes["browser.resource_path"]);
    expect(spans.filter((span) => span.name === "browser.navigation")).toHaveLength(1);
    expect(resourcePaths.toSorted()).toEqual(PAGE_RESOURCES.map(({ path }) => path).toSorted());
    expect(resourcePaths).not.toContain(BROWSER_SPANS_PATH);
  });

  it("never posts an empty batch", () => {
    for (const batch of batches) expect(batch.spans.length).toBeGreaterThan(0);
  });
});
