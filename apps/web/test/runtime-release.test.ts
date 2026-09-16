import { describe, expect, it } from "vitest";
import type { App } from "@lesto/kernel";
import { runtimeRelease, withRuntimeRelease } from "../runtime/release";
import { runtimeConfiguration } from "../runtime/config";

const releaseCommit = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;
const app: App = {
  migrationsApplied: [],
  handle: () => Promise.resolve({ status: 204, headers: {}, body: "" }),
};

describe("runtime release identity", () => {
  it("requires both well-formed identity fields without reflecting invalid input", () => {
    expect(runtimeRelease({})).toBeUndefined();
    expect(
      runtimeRelease({
        SNACKDAY_RELEASE_COMMIT: releaseCommit,
        SNACKDAY_ARTIFACT_DIGEST: artifactDigest,
      }),
    ).toEqual({ releaseCommit, artifactDigest });
    for (const environment of [
      { SNACKDAY_RELEASE_COMMIT: releaseCommit },
      { SNACKDAY_ARTIFACT_DIGEST: artifactDigest },
      { SNACKDAY_RELEASE_COMMIT: "secret-value", SNACKDAY_ARTIFACT_DIGEST: artifactDigest },
      { SNACKDAY_RELEASE_COMMIT: releaseCommit, SNACKDAY_ARTIFACT_DIGEST: "secret-value" },
    ]) {
      expect(() => runtimeRelease(environment)).toThrow(
        "Runtime release requires a valid source commit and artifact digest.",
      );
    }
  });

  it("serves only the configured immutable identity and forbids caching", async () => {
    const release = { releaseCommit, artifactDigest };
    const wrapped = withRuntimeRelease(app, release);
    release.releaseCommit = "c".repeat(40);
    const response = await wrapped.handle("GET", "/__snackday/release", {
      headers: { "x-release-commit": "d".repeat(40) },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ releaseCommit, artifactDigest });
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect((await wrapped.handle("POST", "/__snackday/release")).status).toBe(404);
    expect((await wrapped.handle("GET", "/api/teams")).status).toBe(204);
  });

  it("withholds the endpoint when no verified boot identity was supplied", async () => {
    expect(
      (await withRuntimeRelease(app, undefined).handle("GET", "/__snackday/release")).status,
    ).toBe(404);
  });

  it("threads the boot release through runtime configuration", () => {
    const configuration = runtimeConfiguration({
      SNACKDAY_RUNTIME_MODE: "staging",
      LESTO_DB: "/tmp/snackday-release-test.db",
      SNACKDAY_PUBLIC_BASE_URL: "https://staging.example.com",
      SNACKDAY_APPLE_CLIENT_ID: "com.snackday.test",
      SNACKDAY_RELEASE_COMMIT: releaseCommit,
      SNACKDAY_ARTIFACT_DIGEST: artifactDigest,
    });
    expect(configuration.release).toEqual({ releaseCommit, artifactDigest });
  });

  it("exits with a structured redacted startup failure", async () => {
    const child = Bun.spawn(
      [process.execPath, new URL("../runtime/server.ts", import.meta.url).pathname],
      {
        env: { PATH: process.env["PATH"], SNACKDAY_RUNTIME_MODE: "invalid-private-value" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({ level: "error", event: "runtime.startup_failed" });
  });
});
