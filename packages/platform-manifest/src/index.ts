import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import Ajv2020 from "ajv/dist/2020";

import manifestSchema from "../schema/platform-manifest-v0.schema.json";
import {
  canonicalize,
  collectNullPointers,
  jsonPointerValue,
  normalizeTimestamp,
} from "./canonical";

export {
  canonicalize,
  collectNullPointers,
  jsonPointerValue,
  normalizeTimestamp,
} from "./canonical";

export const MANIFEST_SCHEMA = "platform-manifest/v0" as const;
export const GENERATOR_TOOL = "@snackday/platform-manifest" as const;

const validateManifestSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
  manifestSchema,
);

export interface RepoFact {
  name: string;
  path: string;
  head: string;
  committedAt: string;
  branch: string;
  remote: string | null;
  upstream: { configured: boolean; ahead: number; behind: number } | null;
  dirty: { clean: boolean; fileCount: number };
  latestTag: string | null;
  tagsAuthoritative: boolean;
  releasePipeline: "dispatch-only" | "none" | "tag-push";
  gateCommand: string;
  gateEnforcedInCI: boolean;
}

export interface ManifestFacts {
  generatorVersion: string;
  repos: RepoFact[];
  contracts: {
    studio: {
      apiContractVersion: string;
      openapiSha256: string;
      wsEventSchemaSha256: string;
      dbSchemaVersion: number;
    };
    lesto: {
      deployJsonSchemaVersion: number;
      studioConsumerPinnedVersion: number;
      npmSurfaceVersion: string | null;
      scaffoldDepRange: string;
      packageCount: number | null;
    };
  };
  releases: {
    studio: ReleaseFact | null;
    roof: ReleaseFact | null;
    lesto: ReleaseFact | null;
    reasonForNulls: string | null;
  };
  rollback: RollbackFact[];
  apps: AppFact[];
  unknowns: UnknownFact[];
}

export interface ReleaseFact {
  channel: string;
  version: string;
  locallyVerified: boolean;
}

export interface RollbackFact {
  component: string;
  mechanism:
    | "appcast-repoint-unscripted"
    | "none-roll-forward"
    | "pointer-flip"
    | "undocumented-manual"
    | "unknown";
  scripted: boolean;
  everExercised: boolean;
}

export interface AppFact {
  name: string;
  lestoDepRange: string;
  wranglerConfig: string;
  deployedVersion: string | null;
  migrationVersions: number[] | null;
}

export interface UnknownFact {
  field: string;
  reason: string;
}

export interface GeneratedManifest {
  bytes: Uint8Array;
  digest: string;
  sidecar: string;
  value: Record<string, unknown>;
}

function compareBy<T>(getValue: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  };
}

export function generateManifest(facts: ManifestFacts): GeneratedManifest {
  assertExactComponents(
    facts.repos.map((repo) => repo.name),
    "repository",
  );
  assertExactComponents(
    facts.rollback.map((rollback) => rollback.component),
    "rollback",
  );
  assertUnique(
    facts.apps.map((app) => app.name),
    "application names",
  );
  assertUnique(
    facts.unknowns.map((unknown) => unknown.field),
    "unknown fields",
  );
  for (const app of facts.apps) {
    if (app.migrationVersions !== null) {
      assertUnique(app.migrationVersions, `migration versions for ${app.name}`);
    }
  }
  const committedAt = facts.repos.map((repo) => normalizeTimestamp(repo.committedAt)).sort();
  const repos = facts.repos
    .map(({ committedAt: _committedAt, ...repo }) => ({
      ...repo,
      durable: repo.upstream?.configured === true && repo.upstream.ahead === 0 && repo.dirty.clean,
      operationalFactsRole: "non-authoritative" as const,
    }))
    .sort(compareBy((repo) => repo.name));
  const value = {
    schema: MANIFEST_SCHEMA,
    signed: false,
    generatedAt: committedAt.at(-1)!,
    generator: { tool: GENERATOR_TOOL, version: facts.generatorVersion },
    authorization: { mergeReceipts: null, reason: "NO_AUTHORIZATION_LEDGER" },
    repos,
    contracts: {
      studio: { ...facts.contracts.studio, hashRole: "diagnostic" },
      lesto: {
        ...facts.contracts.lesto,
        remoteTruthRole: "non-authoritative",
        compatStatus:
          facts.contracts.lesto.deployJsonSchemaVersion ===
          facts.contracts.lesto.studioConsumerPinnedVersion
            ? "consistent"
            : "inconsistent",
      },
      templateContractVersion: null,
    },
    releases: { ...facts.releases, remoteTruthRole: "non-authoritative" },
    rollback: facts.rollback
      .map((rollback) => ({ ...rollback, evidenceRole: "non-authoritative" }))
      .sort(compareBy((rollback) => rollback.component)),
    apps: facts.apps
      .map((app) => ({
        ...app,
        migrationVersions:
          app.migrationVersions === null
            ? null
            : [...app.migrationVersions].sort((left, right) => left - right),
      }))
      .sort(compareBy((app) => app.name)),
    unknowns: [...facts.unknowns].sort(compareBy((unknown) => unknown.field)),
  };
  assertNullLedger(value);
  if (!validateManifestSchema(value)) {
    const details = validateManifestSchema.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new TypeError(`Generated manifest violates platform-manifest/v0 schema: ${details}`);
  }
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, digest, sidecar: `${digest}  platform-manifest-v0.json`, value };
}

const PLATFORM_COMPONENTS = ["lesto", "roof", "snackday", "studio"] as const;

function assertExactComponents(names: string[], kind: string): void {
  const sorted = [...names].sort();
  if (
    sorted.length !== PLATFORM_COMPONENTS.length ||
    sorted.some((name, index) => name !== PLATFORM_COMPONENTS[index])
  ) {
    throw new TypeError(`${kind} facts must contain exactly: ${PLATFORM_COMPONENTS.join(", ")}`);
  }
}

function assertUnique<T>(values: T[], kind: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${kind} must be unique`);
}

function assertNullLedger(value: Record<string, unknown>): void {
  const nulls = collectNullPointers(value).sort();
  const unknowns = (value["unknowns"] as UnknownFact[]).map((unknown) => unknown.field);
  const missing = nulls.filter((pointer) => !unknowns.includes(pointer));
  const extraneous = unknowns.filter((pointer) => jsonPointerValue(value, pointer) !== null);
  if (missing.length > 0 || extraneous.length > 0) {
    throw new TypeError(
      `Unknown ledger must exactly match semantic nulls; missing=[${missing.join(", ")}], nonNull=[${extraneous.join(", ")}]`,
    );
  }
}

export * from "./verify";

export async function writeManifest(
  outputPath: string,
  facts: ManifestFacts,
): Promise<GeneratedManifest> {
  const generated = generateManifest(facts);
  await writeFile(outputPath, generated.bytes);
  await writeFile(`${outputPath}.sha256`, `${generated.digest}  ${basename(outputPath)}`);
  return generated;
}
