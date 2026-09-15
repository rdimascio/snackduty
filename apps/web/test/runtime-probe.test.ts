import { describe, expect, it } from "vitest";

import { probeRemoteRuntime } from "../../../scripts/runtime/probe-remote";

describe("remote runtime probe", () => {
  it("reports only preliminary evidence even when health and auth guards pass", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const status = url.endsWith("/api/dev/sign-in") ? 404 : 200;
      return Promise.resolve(new Response(null, { status }));
    };

    const receipt = await probeRemoteRuntime(
      "https://staging.snackduty.test",
      fetcher,
      () => new Date("2026-09-14T12:00:00.000Z"),
    );

    expect(receipt).toEqual({
      origin: "https://staging.snackduty.test",
      checkedAt: "2026-09-14T12:00:00.000Z",
      healthStatus: 200,
      readinessStatus: 200,
      developmentSignInStatus: 404,
      preliminarySurfaceVerified: true,
      stagingVerified: false,
    });
    expect(requests).toEqual([
      "GET https://staging.snackduty.test/health",
      "GET https://staging.snackduty.test/readyz",
      "POST https://staging.snackduty.test/api/dev/sign-in",
    ]);
  });

  it("rejects origins that could leak credentials or use plaintext HTTP", async () => {
    await expect(probeRemoteRuntime("http://staging.snackduty.test")).rejects.toThrow(
      "HTTPS origin",
    );
    await expect(probeRemoteRuntime("https://user@example.test")).rejects.toThrow("HTTPS origin");
  });
});
