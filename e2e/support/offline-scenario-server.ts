import { appendFileSync } from "node:fs";

import { FIXTURE_JSON, isLoopback } from "./reel-fixture";

const BLOCKED_LOG = process.env["E2E_BLOCKED_REQUESTS_LOG"];
if (BLOCKED_LOG === undefined) throw new Error("E2E_BLOCKED_REQUESTS_LOG is not set");

const networkFetch = globalThis.fetch;

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

const offlineFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (isLoopback(url)) return networkFetch(input, init);
  if (Object.hasOwn(FIXTURE_JSON, url)) {
    return Response.json(FIXTURE_JSON[url], {
      headers: { "content-type": "application/json" },
    });
  }
  appendFileSync(BLOCKED_LOG, `${JSON.stringify({ url })}\n`);
  throw new TypeError(`the e2e scenario server blocks non-loopback request ${url}`);
};

globalThis.fetch = Object.assign(offlineFetch, { preconnect: networkFetch.preconnect });

await import("../../apps/web/test/support/csp-scenario-server");
