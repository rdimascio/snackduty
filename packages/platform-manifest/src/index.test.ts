import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  canonicalize,
  generateManifest,
  normalizeTimestamp,
  type ManifestFacts,
  type RepositorySnapshot,
  verifyManifest,
  writeManifest,
} from "./index";

const openapi = "fixture-openapi";
const events = "fixture-events";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function facts(): ManifestFacts {
  return {
    generatorVersion: "0.0.0",
    repos: [
      {
        name: "lesto",
        path: "/fixture/lesto",
        head: "c".repeat(40),
        committedAt: "2026-07-14T09:00:00Z",
        branch: "main",
        remote: "git@example/lesto.git",
        upstream: { configured: true, ahead: 0, behind: 0 },
        dirty: { clean: true, fileCount: 0 },
        latestTag: "v0.1.0",
        tagsAuthoritative: false,
        releasePipeline: "tag-push",
        gateCommand: "bun run gate",
        gateEnforcedInCI: true,
      },
      {
        name: "snackday",
        path: "/fixture/snackday",
        head: "d".repeat(40),
        committedAt: "2026-07-13T09:00:00Z",
        branch: "main",
        remote: null,
        upstream: null,
        dirty: { clean: false, fileCount: 2 },
        latestTag: null,
        tagsAuthoritative: false,
        releasePipeline: "none",
        gateCommand: "bun run gate",
        gateEnforcedInCI: false,
      },
      {
        name: "studio",
        path: "/fixture/studio",
        head: "b".repeat(40),
        committedAt: "2026-07-16T17:30:00.999Z",
        branch: "main",
        remote: "git@example/studio.git",
        upstream: { configured: true, ahead: 0, behind: 0 },
        dirty: { clean: true, fileCount: 0 },
        latestTag: null,
        tagsAuthoritative: false,
        releasePipeline: "dispatch-only",
        gateCommand: "bun run gate",
        gateEnforcedInCI: true,
      },
      {
        name: "roof",
        path: "/fixture/roof",
        head: "a".repeat(40),
        committedAt: "2026-07-15T09:00:00Z",
        branch: "main",
        remote: "git@example/roof.git",
        upstream: { configured: true, ahead: 12, behind: 0 },
        dirty: { clean: true, fileCount: 0 },
        latestTag: null,
        tagsAuthoritative: false,
        releasePipeline: "tag-push",
        gateCommand: "swift test",
        gateEnforcedInCI: true,
      },
    ],
    contracts: {
      studio: {
        apiContractVersion: "1.0.0",
        openapiSha256: hash(openapi),
        wsEventSchemaSha256: hash(events),
        dbSchemaVersion: 71,
      },
      lesto: {
        deployJsonSchemaVersion: 1,
        studioConsumerPinnedVersion: 1,
        npmSurfaceVersion: null,
        scaffoldDepRange: "^0.2.0",
        packageCount: 49,
      },
    },
    releases: {
      studio: null,
      roof: null,
      lesto: { channel: "npm", version: "0.2.0", locallyVerified: false },
      reasonForNulls: "NO_TAGGED_RELEASE_EVER_CUT",
    },
    rollback: [
      {
        component: "lesto",
        mechanism: "pointer-flip",
        scripted: true,
        everExercised: true,
      },
      {
        component: "snackday",
        mechanism: "unknown",
        scripted: false,
        everExercised: false,
      },
      {
        component: "studio",
        mechanism: "undocumented-manual",
        scripted: false,
        everExercised: false,
      },
      {
        component: "roof",
        mechanism: "appcast-repoint-unscripted",
        scripted: false,
        everExercised: false,
      },
    ],
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
      { field: "/apps/0/deployedVersion", reason: "NOT_DEPLOYED" },
      { field: "/apps/0/migrationVersions", reason: "NO_MIGRATIONS" },
      { field: "/authorization/mergeReceipts", reason: "NO_AUTHORIZATION_LEDGER" },
      { field: "/contracts/lesto/npmSurfaceVersion", reason: "REMOTE_TRUTH_UNVERIFIED" },
      { field: "/contracts/templateContractVersion", reason: "NO_TEMPLATE_CONTRACT" },
      { field: "/releases/roof", reason: "NO_TAGGED_RELEASE_EVER_CUT" },
      { field: "/releases/studio", reason: "NO_TAGGED_RELEASE_EVER_CUT" },
      { field: "/repos/1/latestTag", reason: "NO_TAGGED_RELEASE_EVER_CUT" },
      { field: "/repos/2/latestTag", reason: "NO_TAGGED_RELEASE_EVER_CUT" },
      { field: "/repos/2/remote", reason: "NO_REMOTE" },
      { field: "/repos/2/upstream", reason: "NO_UPSTREAM" },
      { field: "/repos/3/latestTag", reason: "NO_TAGGED_RELEASE_EVER_CUT" },
    ],
  };
}

describe("platform manifest v0 generator", () => {
  test("produces byte-identical output for the same facts in different input order", () => {
    const firstFacts = facts();
    const secondFacts = facts();
    secondFacts.repos.reverse();
    secondFacts.rollback.reverse();
    secondFacts.unknowns.reverse();
    const first = generateManifest(firstFacts);
    const second = generateManifest(secondFacts);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(new TextDecoder().decode(first.bytes).endsWith("\n")).toBe(false);
  });

  test("derives timestamp, durability, compatibility, and immutable v0 claims", () => {
    const generated = generateManifest(facts());
    const manifest = generated.value as Record<string, unknown>;
    expect(manifest["generatedAt"]).toBe("2026-07-16T17:30:00Z");
    expect(manifest["signed"]).toBe(false);
    expect(manifest["authorization"]).toEqual({
      mergeReceipts: null,
      reason: "NO_AUTHORIZATION_LEDGER",
    });
    expect(manifest["repos"]).toMatchObject([
      { name: "lesto", durable: true },
      { name: "roof", durable: false },
      { name: "snackday", durable: false },
      { name: "studio", durable: true },
    ]);
    expect(manifest["contracts"]).toMatchObject({
      lesto: { compatStatus: "consistent" },
      templateContractVersion: null,
    });
  });

  test("uses canonical key ordering and rejects values outside the JSON domain", () => {
    expect(canonicalize({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalize({ "\u{10000}": 1, "\ue000": 2 })).toBe('{"𐀀":1,"":2}');
    expect(canonicalize('quote:" control:\b slash:/')).toBe('"quote:\\" control:\\b slash:/"');
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(() => canonicalize(Number.NaN)).toThrow("finite, safe integers");
    expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 1)).toThrow("finite, safe integers");
    expect(() => canonicalize(-0)).toThrow("negative zero");
    expect(() => canonicalize("\ud800")).toThrow("lone Unicode surrogate");
    expect(() => canonicalize("\udc00")).toThrow("lone Unicode surrogate");
  });

  test("requires exact platform repository and rollback coverage", () => {
    const missingRepo = facts();
    missingRepo.repos.pop();
    expect(() => generateManifest(missingRepo)).toThrow("repository facts must contain exactly");

    const duplicateRollback = facts();
    duplicateRollback.rollback[0] = { ...duplicateRollback.rollback[1]! };
    expect(() => generateManifest(duplicateRollback)).toThrow(
      "rollback facts must contain exactly",
    );
  });

  test("requires the unknown ledger to exactly describe every semantic null", () => {
    const missing = facts();
    missing.unknowns = missing.unknowns.filter(
      (unknown) => unknown.field !== "/apps/0/deployedVersion",
    );
    expect(() => generateManifest(missing)).toThrow("missing=[/apps/0/deployedVersion]");

    const nonNull = facts();
    nonNull.unknowns.push({ field: "/repos/0/remote", reason: "FALSE_CLAIM" });
    expect(() => generateManifest(nonNull)).toThrow("nonNull=[/repos/0/remote]");
  });

  test("normalizes equivalent timestamps to UTC second precision", () => {
    expect(normalizeTimestamp("2026-07-16T12:30:45.999-07:00")).toBe("2026-07-16T19:30:45Z");
    expect(() => normalizeTimestamp("not-a-timestamp")).toThrow("Invalid commit timestamp");
  });

  test("emits a fixture accepted by the verifier", async () => {
    const input = facts();
    const directory = await mkdtemp(join(tmpdir(), "platform-manifest-generator-"));
    const manifestPath = join(directory, "platform-manifest-v0.json");
    await writeManifest(manifestPath, input);
    const repos = new Map(input.repos.map((repo) => [repo.path, repo]));
    const inspectRepository = (path: string): RepositorySnapshot => {
      const repo = repos.get(path)!;
      return {
        objectExists: true,
        head: repo.head,
        branch: repo.branch,
        upstream: repo.upstream,
        latestTag: repo.latestTag,
        dirtyFileCount: repo.dirty.fileCount,
        commitTimestamp: repo.committedAt,
        readPinnedFile(_head, file) {
          const content = pinnedContent(repo.name, file);
          return content === null ? null : new TextEncoder().encode(content);
        },
        listPinnedFiles(_head, path) {
          return repo.name === "lesto" && path === "packages"
            ? Array.from({ length: 49 }, (_, index) => `packages/p${index}/package.json`)
            : [];
        },
      };
    };
    expect(verifyManifest({ manifestPath, inspectRepository })).toEqual({
      ok: true,
      exitCode: 0,
      findings: [],
      warnings: [],
    });
  });
});

function pinnedContent(repo: string, path: string): string | null {
  if (repo === "studio" && path === "api/openapi.json") return openapi;
  if (repo === "studio" && path === "shared/src/event.ts") return events;
  if (repo === "studio" && path === "shared/src/contract-version.ts") {
    return 'export const API_CONTRACT_VERSION = "1.0.0";';
  }
  if (repo === "studio" && path === "api/src/db/index.ts") {
    return "export const SCHEMA_VERSION = 71;";
  }
  if (repo === "studio" && path === "api/src/services/lesto-deploy.ts") {
    return "const contract = { schemaVersion: z.literal(1) };";
  }
  if (repo === "lesto" && path === "packages/cli/src/run.ts") {
    return "export const DEPLOY_JSON_SCHEMA_VERSION = 1;";
  }
  if (repo === "lesto" && path === "packages/create-lesto/src/scaffold.ts") {
    return 'export const LESTO_DEP_RANGE = "^0.2.0";';
  }
  if (repo === "snackday" && path === "apps/web/package.json") {
    return JSON.stringify({ dependencies: { "@lesto/core": "^0.2.0" } });
  }
  if (repo === "snackday" && path === "apps/web/wrangler.jsonc") return "{}";
  return null;
}
