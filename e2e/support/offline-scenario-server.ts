import { appendFileSync } from "node:fs";

import { createOfflineFetch } from "./offline-fetch";

const BLOCKED_LOG = process.env["E2E_BLOCKED_REQUESTS_LOG"];
if (BLOCKED_LOG === undefined) throw new Error("E2E_BLOCKED_REQUESTS_LOG is not set");
const blockedLog = BLOCKED_LOG;

const networkFetch = globalThis.fetch;
const offlineFetch = createOfflineFetch(networkFetch, (url) => {
  appendFileSync(blockedLog, `${JSON.stringify({ url })}\n`);
});

globalThis.fetch = Object.assign(offlineFetch, { preconnect: networkFetch.preconnect });

await import("../../apps/web/test/support/csp-scenario-server");
