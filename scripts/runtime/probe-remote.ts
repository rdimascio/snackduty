const PROBE_TIMEOUT_MS = 10_000;

export interface RuntimeProbeReceipt {
  readonly origin: string;
  readonly checkedAt: string;
  readonly healthStatus: number;
  readonly readinessStatus: number;
  readonly developmentSignInStatus: number;
  readonly preliminarySurfaceVerified: boolean;
  readonly stagingVerified: false;
}

function remoteOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Runtime probe origin must be an HTTPS origin without credentials.");
  }
  return url;
}

async function status(fetcher: typeof fetch, url: URL, method: "GET" | "POST"): Promise<number> {
  const response = await fetcher(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}

export async function probeRemoteRuntime(
  value: string,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<RuntimeProbeReceipt> {
  const origin = remoteOrigin(value);
  const healthStatus = await status(fetcher, new URL("/health", origin), "GET");
  const readinessStatus = await status(fetcher, new URL("/readyz", origin), "GET");
  const developmentSignInStatus = await status(
    fetcher,
    new URL("/api/dev/sign-in", origin),
    "POST",
  );
  const preliminarySurfaceVerified =
    healthStatus === 200 && readinessStatus === 200 && developmentSignInStatus === 404;

  return {
    origin: origin.origin,
    checkedAt: now().toISOString(),
    healthStatus,
    readinessStatus,
    developmentSignInStatus,
    preliminarySurfaceVerified,
    stagingVerified: false,
  };
}

if (import.meta.main) {
  const origin = process.argv[2];
  if (origin === undefined)
    throw new Error("Usage: bun scripts/runtime/probe-remote.ts <https-origin>");
  const receipt = await probeRemoteRuntime(origin);
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.preliminarySurfaceVerified) process.exitCode = 1;
}
