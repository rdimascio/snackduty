import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalizeJson, type RepositorySnapshot, verifyManifest } from "./verify";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const openapi = "openapi";
const events = "events";
const heads = Object.fromEntries(
  ["lesto", "roof", "snackday", "studio"].map((name, index) => [
    name,
    String(index + 1).repeat(40),
  ]),
);

function manifest(): Record<string, unknown> {
  return {
    schema: "platform-manifest/v0",
    signed: false,
    generatedAt: "2026-07-16T19:00:00Z",
    generator: { tool: "test", version: "0" },
    authorization: { mergeReceipts: null, reason: "NO_AUTHORIZATION_LEDGER" },
    repos: ["lesto", "roof", "snackday", "studio"].map((name) => ({
      name,
      path: `/repo/${name}`,
      head: heads[name],
      branch: "main",
      remote: "origin",
      upstream: { configured: true, ahead: 0, behind: 0 },
      dirty: { clean: true, fileCount: 0 },
      durable: true,
      latestTag: "v0",
      tagsAuthoritative: true,
      releasePipeline: "none",
      gateCommand: "bun run gate",
      gateEnforcedInCI: true,
      operationalFactsRole: "non-authoritative",
    })),
    contracts: {
      studio: {
        apiContractVersion: "1.0.0",
        openapiSha256: hash(openapi),
        wsEventSchemaSha256: hash(events),
        dbSchemaVersion: 71,
        hashRole: "diagnostic",
      },
      lesto: {
        deployJsonSchemaVersion: 1,
        studioConsumerPinnedVersion: 1,
        compatStatus: "consistent",
        npmSurfaceVersion: "0.2.0",
        scaffoldDepRange: "^0.2.0",
        packageCount: 49,
        remoteTruthRole: "non-authoritative",
      },
      templateContractVersion: null,
    },
    releases: {
      studio: { channel: "test", version: "0", locallyVerified: true },
      roof: { channel: "test", version: "0", locallyVerified: true },
      lesto: { channel: "npm", version: "0.2.0", locallyVerified: false },
      reasonForNulls: "NO_TAGGED_RELEASE_EVER_CUT",
      remoteTruthRole: "non-authoritative",
    },
    rollback: ["lesto", "roof", "snackday", "studio"].map((component) => ({
      component,
      mechanism: "unknown",
      scripted: false,
      everExercised: false,
      evidenceRole: "non-authoritative",
    })),
    apps: [
      {
        name: "snackday-web",
        lestoDepRange: "^0.2.0",
        wranglerConfig: "apps/web/wrangler.jsonc",
        deployedVersion: null,
        migrationVersions: null,
      },
    ],
    unknowns: [
      { field: "/apps/0/deployedVersion", reason: "NOT_VERIFIED" },
      { field: "/apps/0/migrationVersions", reason: "NOT_EXTRACTED" },
      { field: "/authorization/mergeReceipts", reason: "NO_AUTHORIZATION_LEDGER" },
      { field: "/contracts/templateContractVersion", reason: "NO_TEMPLATE_CONTRACT" },
    ],
  };
}

function snapshot(name: string, overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    objectExists: true,
    head: heads[name]!,
    branch: "main",
    upstream: { configured: true, ahead: 0, behind: 0 },
    latestTag: "v0",
    dirtyFileCount: 0,
    commitTimestamp: name === "studio" ? "2026-07-16T19:00:00Z" : "2026-07-16T18:00:00Z",
    readPinnedFile(_head, path) {
      const sources: Record<string, string> = {
        "studio:api/openapi.json": openapi,
        "studio:shared/src/event.ts": events,
        "studio:shared/src/contract-version.ts": `export const API_CONTRACT_VERSION = "1.0.0"`,
        "studio:api/src/db/index.ts": "const SCHEMA_VERSION = 71",
        "studio:api/src/services/lesto-deploy.ts": "schemaVersion: z.literal(1)",
        "lesto:packages/cli/src/run.ts": "const DEPLOY_JSON_SCHEMA_VERSION = 1",
        "lesto:packages/create-lesto/src/scaffold.ts": `const LESTO_DEP_RANGE = "^0.2.0"`,
        "snackday:apps/web/package.json": JSON.stringify({
          dependencies: { "@lesto/app": "^0.2.0" },
        }),
        "snackday:apps/web/wrangler.jsonc": "{}",
      };
      const source = sources[`${name}:${path}`];
      if (source !== undefined) return new TextEncoder().encode(source);
      return null;
    },
    listPinnedFiles(_head, path) {
      return name === "lesto" && path === "packages"
        ? Array.from({ length: 49 }, (_, index) => `packages/p${index}/package.json`)
        : [];
    },
    ...overrides,
  };
}

function writeFixture(
  value: Record<string, unknown>,
  transform: (canonical: string) => string = (canonical) => canonical,
) {
  const directory = mkdtempSync(join(tmpdir(), "manifest-verifier-"));
  const path = join(directory, "platform-manifest-v0.json");
  const bytes = transform(canonicalizeJson(value as never));
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sha256`, `${hash(bytes)}  platform-manifest-v0.json`);
  return { path, inspectRepository: (path: string) => snapshot(path.split("/").at(-1)!) };
}

describe("verifyManifest", () => {
  test("accepts a canonical, consistent manifest with pinned facts", () => {
    const fixture = writeFixture(manifest());
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository }),
    ).toEqual({ ok: true, exitCode: 0, findings: [], warnings: [] });
  });

  test("checks the sidecar before trusting content", () => {
    const fixture = writeFixture(manifest());
    writeFileSync(`${fixture.path}.sha256`, `${"0".repeat(64)}  platform-manifest-v0.json`);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(4);
  });

  test("returns digest failure before parsing malformed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "manifest-verifier-"));
    const path = join(directory, "platform-manifest-v0.json");
    writeFileSync(path, "{");
    writeFileSync(`${path}.sha256`, `${"0".repeat(64)}  platform-manifest-v0.json`);
    let inspectorCalls = 0;
    const result = verifyManifest({
      manifestPath: path,
      inspectRepository: () => {
        inspectorCalls += 1;
        throw new Error("must not inspect");
      },
    });
    expect(result.exitCode).toBe(4);
    expect(inspectorCalls).toBe(0);
  });

  test("rejects non-canonical JSON after a matching digest", () => {
    const fixture = writeFixture(
      manifest(),
      (canonical) => `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`,
    );
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(3);
  });

  test("rejects receipt and signature claims at the schema phase", () => {
    const value = manifest();
    value["signed"] = true;
    expect(
      verifyManifest({ ...writeFixture(value), manifestPath: writeFixture(value).path }).exitCode,
    ).toBe(2);
  });

  test("distinguishes internal inconsistency from pinned-content tampering", () => {
    const inconsistent = manifest();
    const repos = inconsistent["repos"] as Array<Record<string, unknown>>;
    repos[0]!["durable"] = false;
    let fixture = writeFixture(inconsistent);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(7);

    const tampered = manifest();
    (tampered["contracts"] as Record<string, Record<string, unknown>>)["studio"]!["openapiSha256"] =
      "0".repeat(64);
    fixture = writeFixture(tampered);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(6);
  });

  test("reports world drift but only warns about dirty-file drift", () => {
    let fixture = writeFixture(manifest());
    const driftInspector = (path: string) =>
      snapshot(path.split("/").at(-1)!, { head: "f".repeat(40) });
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: driftInspector }).exitCode,
    ).toBe(5);

    fixture = writeFixture(manifest());
    const dirtyInspector = (path: string) =>
      snapshot(path.split("/").at(-1)!, { dirtyFileCount: 9 });
    const result = verifyManifest({
      manifestPath: fixture.path,
      inspectRepository: dirtyInspector,
    });
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toHaveLength(4);
  });

  test("uses environment code when a pinned commit is unavailable", () => {
    const fixture = writeFixture(manifest());
    const inspector = (path: string) => snapshot(path.split("/").at(-1)!, { objectExists: false });
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(10);
  });

  test("does not inspect manifest-supplied paths before integrity and schema checks", () => {
    let calls = 0;
    const inspector = (): RepositorySnapshot => {
      calls += 1;
      throw new Error("must not run");
    };
    const digestFixture = writeFixture(manifest());
    writeFileSync(`${digestFixture.path}.sha256`, `${"0".repeat(64)}  platform-manifest-v0.json`);
    expect(
      verifyManifest({ manifestPath: digestFixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(4);

    const canonicalFixture = writeFixture(manifest(), (bytes) => `${bytes}\n`);
    expect(
      verifyManifest({ manifestPath: canonicalFixture.path, inspectRepository: inspector })
        .exitCode,
    ).toBe(3);

    const malformed = manifest();
    (malformed["releases"] as Record<string, unknown>)["studio"] = { channel: "test" };
    const schemaFixture = writeFixture(malformed);
    expect(
      verifyManifest({ manifestPath: schemaFixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(2);
    expect(calls).toBe(0);
  });

  test("published schema rejects extras, malformed apps, and negative counts", () => {
    const cases = [
      () => {
        const value = manifest();
        value["extra"] = true;
        return value;
      },
      () => {
        const value = manifest();
        (value["apps"] as Record<string, unknown>[])[0]!["lestoDepRange"] = 2;
        return value;
      },
      () => {
        const value = manifest();
        ((value["repos"] as Record<string, unknown>[])[0]!["dirty"] as Record<string, unknown>)[
          "fileCount"
        ] = -1;
        return value;
      },
    ];
    for (const makeValue of cases) {
      const fixture = writeFixture(makeValue());
      expect(
        verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
          .exitCode,
      ).toBe(2);
    }
  });

  test("requires the exact four repository identities", () => {
    const value = manifest();
    (value["repos"] as Record<string, unknown>[])[0]!["name"] = "attacker";
    const fixture = writeFixture(value);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(2);
  });

  test("normalizes timezone-offset commit instants", () => {
    const fixture = writeFixture(manifest());
    const inspector = (path: string) => {
      const name = path.split("/").at(-1)!;
      return snapshot(name, {
        commitTimestamp:
          name === "studio" ? "2026-07-16T12:00:00-07:00" : "2026-07-16T11:00:00-07:00",
      });
    };
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(0);
  });

  test("fails closed when a required pinned extractor source is missing", () => {
    const fixture = writeFixture(manifest());
    const inspector = (path: string) => {
      const name = path.split("/").at(-1)!;
      const base = snapshot(name);
      return name === "lesto" ? { ...base, readPinnedFile: () => null } : base;
    };
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(6);
  });

  test.each([
    ["studio", "api/openapi.json"],
    ["studio", "shared/src/event.ts"],
    ["studio", "shared/src/contract-version.ts"],
    ["studio", "api/src/db/index.ts"],
    ["studio", "api/src/services/lesto-deploy.ts"],
    ["lesto", "packages/cli/src/run.ts"],
    ["lesto", "packages/create-lesto/src/scaffold.ts"],
    ["snackday", "apps/web/package.json"],
    ["snackday", "apps/web/wrangler.jsonc"],
  ])("rejects missing %s pinned source %s", (targetRepo, missingPath) => {
    const fixture = writeFixture(manifest());
    const inspector = (repoPath: string) => {
      const name = repoPath.split("/").at(-1)!;
      const base = snapshot(name);
      return name === targetRepo
        ? {
            ...base,
            readPinnedFile: (head: string, path: string) =>
              path === missingPath ? null : base.readPinnedFile(head, path),
          }
        : base;
    };
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(6);
  });

  test("rejects a missing pinned package inventory", () => {
    const fixture = writeFixture(manifest());
    const inspector = (repoPath: string) => {
      const name = repoPath.split("/").at(-1)!;
      const base = snapshot(name);
      return name === "lesto" ? { ...base, listPinnedFiles: () => null } : base;
    };
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: inspector }).exitCode,
    ).toBe(6);
  });

  test.each([
    [
      "API version",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["studio"]![
          "apiContractVersion"
        ] = "9.0.0"),
    ],
    [
      "DB schema",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["studio"]![
          "dbSchemaVersion"
        ] = 72),
    ],
    [
      "deploy schemas",
      (value: Record<string, unknown>) => {
        const lesto = (value["contracts"] as Record<string, Record<string, unknown>>)["lesto"]!;
        lesto["deployJsonSchemaVersion"] = 2;
        lesto["studioConsumerPinnedVersion"] = 2;
      },
    ],
    [
      "scaffold range",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["lesto"]![
          "scaffoldDepRange"
        ] = "^9.0.0"),
    ],
    [
      "package count",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["lesto"]!["packageCount"] =
          48),
    ],
    [
      "app dependency",
      (value: Record<string, unknown>) =>
        ((value["apps"] as Record<string, unknown>[])[0]!["lestoDepRange"] = "^9.0.0"),
    ],
    [
      "OpenAPI hash",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["studio"]![
          "openapiSha256"
        ] = "0".repeat(64)),
    ],
    [
      "event hash",
      (value: Record<string, unknown>) =>
        ((value["contracts"] as Record<string, Record<string, unknown>>)["studio"]![
          "wsEventSchemaSha256"
        ] = "0".repeat(64)),
    ],
  ])("rejects a mutated pinned %s claim", (_label, mutate) => {
    const value = manifest();
    mutate(value);
    const fixture = writeFixture(value);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(6);
  });

  test("requires sorted unique selected keys for unknowns, apps, and rollback", () => {
    const reorderedUnknowns = manifest();
    (reorderedUnknowns["unknowns"] as unknown[]).reverse();
    let fixture = writeFixture(reorderedUnknowns);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(7);

    const duplicateApp = manifest();
    (duplicateApp["apps"] as Record<string, unknown>[]).push({
      name: "snackday-web",
      lestoDepRange: "^0.2.0",
      wranglerConfig: "apps/web/other-wrangler.jsonc",
      deployedVersion: "test",
      migrationVersions: [],
    });
    fixture = writeFixture(duplicateApp);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(2);

    const duplicateRollback = manifest();
    const rollback = duplicateRollback["rollback"] as Record<string, unknown>[];
    rollback[1]!["component"] = "lesto";
    rollback[1]!["scripted"] = true;
    fixture = writeFixture(duplicateRollback);
    expect(
      verifyManifest({ manifestPath: fixture.path, inspectRepository: fixture.inspectRepository })
        .exitCode,
    ).toBe(2);
  });
});
