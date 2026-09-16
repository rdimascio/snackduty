import type { App } from "@lesto/kernel";

export interface RuntimeRelease {
  readonly releaseCommit: string;
  readonly artifactDigest: string;
}

/** Boot verifies the installed archive before passing these non-secret values. */
export function runtimeRelease(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeRelease | undefined {
  const releaseCommit = environment["SNACKDAY_RELEASE_COMMIT"];
  const artifactDigest = environment["SNACKDAY_ARTIFACT_DIGEST"];
  if (releaseCommit === undefined && artifactDigest === undefined) return undefined;
  if (
    releaseCommit === undefined ||
    !/^[0-9a-f]{40}$/.test(releaseCommit) ||
    artifactDigest === undefined ||
    !/^sha256:[0-9a-f]{64}$/.test(artifactDigest)
  ) {
    throw new Error("Runtime release requires a valid source commit and artifact digest.");
  }
  return Object.freeze({ releaseCommit, artifactDigest });
}

export function withRuntimeRelease(app: App, release: RuntimeRelease | undefined): App {
  // Snapshot once; requests cannot influence deployment identity.
  const body =
    release === undefined
      ? undefined
      : JSON.stringify({
          releaseCommit: release.releaseCommit,
          artifactDigest: release.artifactDigest,
        });
  return {
    migrationsApplied: app.migrationsApplied,
    handle(method, path, options) {
      if (path === "/__snackday/release") {
        return Promise.resolve({
          status: method === "GET" && body !== undefined ? 200 : 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
          body: method === "GET" && body !== undefined ? body : '{"error":"not found"}',
        });
      }
      return app.handle(method, path, options);
    },
  };
}
