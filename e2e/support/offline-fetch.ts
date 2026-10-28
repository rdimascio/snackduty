import { FIXTURE_JSON, isLoopback } from "./reel-fixture";

type Fetch = typeof globalThis.fetch;

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class BlockedRequestError extends TypeError {
  constructor(readonly url: string) {
    super(`the e2e scenario server blocks non-loopback request ${url}`);
  }
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function followInit(status: number, method: string, init?: RequestInit): RequestInit {
  const becomesGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
  if (!becomesGet) return { ...init, redirect: "manual" };
  const { body: _body, ...rest } = init ?? {};
  return { ...rest, method: "GET", redirect: "manual" };
}

export function createOfflineFetch(networkFetch: Fetch, block: (url: string) => void) {
  const refuse = (url: string): never => {
    block(url);
    throw new BlockedRequestError(url);
  };

  const loopbackFetch = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    hops: number,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const response = await networkFetch(input, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    const next = new URL(location, url).href;
    if (!isLoopback(next)) return refuse(next);
    if (init?.redirect === "manual") return response;
    if (init?.redirect === "error") throw new TypeError(`redirect to ${next} with redirect: error`);
    if (hops >= MAX_REDIRECTS) throw new TypeError(`too many redirects from ${url}`);
    const method = requestMethod(input, init);
    return loopbackFetch(next, followInit(response.status, method, init), hops + 1);
  };

  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (isLoopback(url)) return loopbackFetch(input, init, 0);
    if (Object.hasOwn(FIXTURE_JSON, url)) {
      return Promise.resolve(
        Response.json(FIXTURE_JSON[url], { headers: { "content-type": "application/json" } }),
      );
    }
    block(url);
    return Promise.reject(new BlockedRequestError(url));
  };
}
