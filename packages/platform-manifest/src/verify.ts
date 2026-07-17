import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import manifestSchema from "../schema/platform-manifest-v0.schema.json";
import { canonicalize, normalizeTimestamp } from "./canonical";

export const verificationExitCode = {
  pass: 0,
  schema: 2,
  canonical: 3,
  digest: 4,
  drift: 5,
  pinnedContent: 6,
  consistency: 7,
  environment: 10,
} as const;

export type VerificationExitCode = (typeof verificationExitCode)[keyof typeof verificationExitCode];

export interface VerificationFinding {
  readonly phase:
    | "environment"
    | "digest"
    | "canonical"
    | "schema"
    | "consistency"
    | "pinned-content"
    | "drift";
  readonly pointer: string;
  readonly expected: string;
  readonly actual: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly exitCode: VerificationExitCode;
  readonly findings: readonly VerificationFinding[];
  readonly warnings: readonly VerificationFinding[];
}

export interface RepositorySnapshot {
  readonly objectExists: boolean;
  readonly head: string;
  readonly branch: string;
  readonly upstream: {
    readonly configured: boolean;
    readonly ahead: number;
    readonly behind: number;
  } | null;
  readonly latestTag: string | null;
  readonly dirtyFileCount: number;
  readonly commitTimestamp: string;
  readPinnedFile(head: string, path: string): Uint8Array | null;
  listPinnedFiles(head: string, path: string): readonly string[] | null;
}

export interface VerifyManifestOptions {
  readonly manifestPath: string;
  readonly digestPath?: string;
  readonly inspectRepository?: (path: string, head: string) => RepositorySnapshot;
}

interface RecordValue extends Record<string, unknown> {
  schema?: unknown;
  signed?: unknown;
  generatedAt?: unknown;
  generator?: unknown;
  tool?: unknown;
  version?: unknown;
  authorization?: unknown;
  mergeReceipts?: unknown;
  reason?: unknown;
  repos?: unknown;
  name?: unknown;
  path?: unknown;
  branch?: unknown;
  head?: unknown;
  remote?: unknown;
  latestTag?: unknown;
  durable?: unknown;
  tagsAuthoritative?: unknown;
  gateEnforcedInCI?: unknown;
  gateCommand?: unknown;
  releasePipeline?: unknown;
  dirty?: unknown;
  clean?: unknown;
  fileCount?: unknown;
  upstream?: unknown;
  configured?: unknown;
  ahead?: unknown;
  behind?: unknown;
  contracts?: unknown;
  templateContractVersion?: unknown;
  studio?: unknown;
  apiContractVersion?: unknown;
  openapiSha256?: unknown;
  wsEventSchemaSha256?: unknown;
  dbSchemaVersion?: unknown;
  hashRole?: unknown;
  lesto?: unknown;
  deployJsonSchemaVersion?: unknown;
  studioConsumerPinnedVersion?: unknown;
  compatStatus?: unknown;
  npmSurfaceVersion?: unknown;
  scaffoldDepRange?: unknown;
  packageCount?: unknown;
  rollback?: unknown;
  component?: unknown;
  mechanism?: unknown;
  scripted?: unknown;
  everExercised?: unknown;
  apps?: unknown;
  unknowns?: unknown;
  field?: unknown;
  dependencies?: unknown;
  wranglerConfig?: unknown;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (value === undefined) return "missing";
  return JSON.stringify(value);
}

function finding(
  phase: VerificationFinding["phase"],
  pointer: string,
  expected: unknown,
  actual: unknown,
): VerificationFinding {
  return { phase, pointer, expected: display(expected), actual: display(actual) };
}

export const canonicalizeJson = canonicalize;

function keysAreExactly(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function validateLegacySchema(value: unknown): VerificationFinding[] {
  const failures: VerificationFinding[] = [];
  const fail = (pointer: string, expected: unknown, actual: unknown): void => {
    failures.push(finding("schema", pointer, expected, actual));
  };
  if (!isRecord(value)) return [finding("schema", "", "object", value)];
  const rootKeys = [
    "schema",
    "signed",
    "generatedAt",
    "generator",
    "authorization",
    "repos",
    "contracts",
    "releases",
    "rollback",
    "apps",
    "unknowns",
  ];
  if (!keysAreExactly(value, rootKeys)) fail("", `keys ${rootKeys.join(",")}`, Object.keys(value));
  if (value.schema !== "platform-manifest/v0")
    fail("/schema", "platform-manifest/v0", value.schema);
  if (value.signed !== false) fail("/signed", false, value.signed);
  if (
    typeof value.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.generatedAt)
  )
    fail("/generatedAt", "UTC timestamp at second precision", value.generatedAt);
  if (
    !isRecord(value.generator) ||
    typeof value.generator.tool !== "string" ||
    typeof value.generator.version !== "string"
  )
    fail("/generator", "{tool:string,version:string}", value.generator);
  if (
    !isRecord(value.authorization) ||
    value.authorization.mergeReceipts !== null ||
    value.authorization.reason !== "NO_AUTHORIZATION_LEDGER"
  )
    fail("/authorization", "v0 null authorization receipt", value.authorization);
  if (!Array.isArray(value.repos) || value.repos.length !== 4)
    fail("/repos", "array of four repositories", value.repos);
  else
    value.repos.forEach((repo, index) => {
      const pointer = `/repos/${index}`;
      if (!isRecord(repo)) return fail(pointer, "repository object", repo);
      if (
        typeof repo.name !== "string" ||
        typeof repo.path !== "string" ||
        typeof repo.branch !== "string"
      )
        fail(pointer, "string name/path/branch", repo);
      if (typeof repo.head !== "string" || !/^[0-9a-f]{40}$/.test(repo.head))
        fail(`${pointer}/head`, "40 lowercase hex characters", repo.head);
      if (!(repo.remote === null || typeof repo.remote === "string"))
        fail(`${pointer}/remote`, "string or null", repo.remote);
      if (!(repo.latestTag === null || typeof repo.latestTag === "string"))
        fail(`${pointer}/latestTag`, "string or null", repo.latestTag);
      if (
        typeof repo.durable !== "boolean" ||
        typeof repo.tagsAuthoritative !== "boolean" ||
        typeof repo.gateEnforcedInCI !== "boolean"
      )
        fail(pointer, "required boolean facts", repo);
      if (
        typeof repo.gateCommand !== "string" ||
        !["tag-push", "dispatch-only", "none"].includes(String(repo.releasePipeline))
      )
        fail(pointer, "gate and release pipeline", repo);
      if (
        !isRecord(repo.dirty) ||
        typeof repo.dirty.clean !== "boolean" ||
        !Number.isSafeInteger(repo.dirty.fileCount) ||
        Number(repo.dirty.fileCount) < 0
      )
        fail(`${pointer}/dirty`, "clean boolean and non-negative integer fileCount", repo.dirty);
      if (
        !(
          repo.upstream === null ||
          (isRecord(repo.upstream) &&
            typeof repo.upstream.configured === "boolean" &&
            Number.isSafeInteger(repo.upstream.ahead) &&
            Number.isSafeInteger(repo.upstream.behind))
        )
      )
        fail(`${pointer}/upstream`, "upstream object or null", repo.upstream);
    });
  if (Array.isArray(value.repos)) {
    const names = value.repos.map((repo) => (isRecord(repo) ? repo.name : undefined));
    if (JSON.stringify(names) !== JSON.stringify([...names].sort()))
      fail("/repos", "sorted by name", names);
  }
  if (!isRecord(value.contracts)) fail("/contracts", "contracts object", value.contracts);
  else {
    if (value.contracts.templateContractVersion !== null)
      fail("/contracts/templateContractVersion", null, value.contracts.templateContractVersion);
    const studio = value.contracts.studio;
    if (
      !isRecord(studio) ||
      typeof studio.apiContractVersion !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(studio.openapiSha256)) ||
      !/^[0-9a-f]{64}$/.test(String(studio.wsEventSchemaSha256)) ||
      !Number.isSafeInteger(studio.dbSchemaVersion) ||
      studio.hashRole !== "diagnostic"
    )
      fail("/contracts/studio", "valid Studio contract facts", studio);
    const lesto = value.contracts.lesto;
    if (
      !isRecord(lesto) ||
      !Number.isSafeInteger(lesto.deployJsonSchemaVersion) ||
      !Number.isSafeInteger(lesto.studioConsumerPinnedVersion) ||
      !["consistent", "inconsistent"].includes(String(lesto.compatStatus)) ||
      !(lesto.npmSurfaceVersion === null || typeof lesto.npmSurfaceVersion === "string") ||
      typeof lesto.scaffoldDepRange !== "string" ||
      !(lesto.packageCount === null || Number.isSafeInteger(lesto.packageCount))
    )
      fail("/contracts/lesto", "valid Lesto contract facts", lesto);
  }
  if (
    !Array.isArray(value.rollback) ||
    value.rollback.some(
      (item) =>
        !isRecord(item) ||
        typeof item.component !== "string" ||
        ![
          "pointer-flip",
          "none-roll-forward",
          "undocumented-manual",
          "appcast-repoint-unscripted",
          "unknown",
        ].includes(String(item.mechanism)) ||
        typeof item.scripted !== "boolean" ||
        typeof item.everExercised !== "boolean",
    )
  )
    fail("/rollback", "valid rollback entries", value.rollback);
  if (!Array.isArray(value.apps)) fail("/apps", "array", value.apps);
  if (
    !Array.isArray(value.unknowns) ||
    value.unknowns.some(
      (item) =>
        !isRecord(item) ||
        typeof item.field !== "string" ||
        !String(item.field).startsWith("/") ||
        typeof item.reason !== "string",
    )
  )
    fail("/unknowns", "JSON pointer/reason entries", value.unknowns);
  return failures;
}

// Retained temporarily only as a differential oracle while the published schema stabilizes.
void validateLegacySchema;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePublishedSchema = ajv.compile(manifestSchema);

function validateSchema(value: unknown): VerificationFinding[] {
  if (validatePublishedSchema(value)) return [];
  return (validatePublishedSchema.errors ?? []).map((error) =>
    finding("schema", error.instancePath || "/", error.message ?? "valid schema", error.data),
  );
}

function collectNullPointers(value: unknown, pointer = ""): string[] {
  if (value === null) return [pointer];
  if (Array.isArray(value))
    return value.flatMap((item, index) => collectNullPointers(item, `${pointer}/${index}`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "unknowns"
      ? []
      : collectNullPointers(item, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}

function runGit(path: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args[0]} failed`);
  return result.stdout.toString().trim();
}

export function inspectGitRepository(path: string, pinnedHead: string): RepositorySnapshot {
  const objectExists =
    Bun.spawnSync(["git", "-C", path, "cat-file", "-e", `${pinnedHead}^{commit}`], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode === 0;
  const upstreamName = (() => {
    try {
      return runGit(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    } catch {
      return null;
    }
  })();
  const counts =
    upstreamName === null
      ? null
      : runGit(path, ["rev-list", "--left-right", "--count", `HEAD...${upstreamName}`])
          .split(/\s+/)
          .map(Number);
  const tag = (() => {
    try {
      return runGit(path, ["describe", "--tags", "--abbrev=0"]);
    } catch {
      return null;
    }
  })();
  const status = runGit(path, ["status", "--porcelain"]);
  return {
    objectExists,
    head: runGit(path, ["rev-parse", "HEAD"]),
    branch: runGit(path, ["branch", "--show-current"]),
    upstream:
      counts === null ? null : { configured: true, ahead: counts[0] ?? 0, behind: counts[1] ?? 0 },
    latestTag: tag,
    dirtyFileCount: status === "" ? 0 : status.split("\n").length,
    commitTimestamp: normalizeTimestamp(runGit(path, ["show", "-s", "--format=%cI", pinnedHead])),
    readPinnedFile(head, filePath) {
      const result = Bun.spawnSync(["git", "-C", path, "show", `${head}:${filePath}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0 ? result.stdout : null;
    },
    listPinnedFiles(head, directoryPath) {
      const result = Bun.spawnSync(
        ["git", "-C", path, "ls-tree", "-r", "--name-only", head, "--", directoryPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      return result.exitCode === 0
        ? result.stdout.toString().trim().split("\n").filter(Boolean)
        : null;
    },
  };
}

const knownPinnedHashes = [
  ["studio", "api/openapi.json", "/contracts/studio/openapiSha256"],
  ["studio", "shared/src/event.ts", "/contracts/studio/wsEventSchemaSha256"],
] as const;

function pointerValue(root: unknown, pointer: string): unknown {
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>((value, key) => {
      if (Array.isArray(value)) return value[Number(key)];
      return isRecord(value) ? value[key] : undefined;
    }, root);
}

interface PinnedExtractor {
  readonly repo: "lesto" | "snackday" | "studio";
  readonly path: string;
  readonly pointer: string;
  extract(text: string): unknown;
}

function matchValue(pattern: RegExp, text: string): string | number | undefined {
  const match = pattern.exec(text)?.[1];
  if (match === undefined) return undefined;
  return /^\d+$/u.test(match) ? Number(match) : match;
}

const pinnedExtractors: readonly PinnedExtractor[] = [
  {
    repo: "studio",
    path: "shared/src/contract-version.ts",
    pointer: "/contracts/studio/apiContractVersion",
    extract: (text) => matchValue(/API_CONTRACT_VERSION\s*=\s*["']([^"']+)["']/u, text),
  },
  {
    repo: "studio",
    path: "api/src/db/index.ts",
    pointer: "/contracts/studio/dbSchemaVersion",
    extract: (text) => matchValue(/SCHEMA_VERSION\s*=\s*(\d+)/u, text),
  },
  {
    repo: "studio",
    path: "api/src/services/lesto-deploy.ts",
    pointer: "/contracts/lesto/studioConsumerPinnedVersion",
    extract: (text) => matchValue(/schemaVersion\s*:\s*z\.literal\((\d+)\)/u, text),
  },
  {
    repo: "lesto",
    path: "packages/cli/src/run.ts",
    pointer: "/contracts/lesto/deployJsonSchemaVersion",
    extract: (text) => matchValue(/DEPLOY_JSON_SCHEMA_VERSION\s*=\s*(\d+)/u, text),
  },
  {
    repo: "lesto",
    path: "packages/create-lesto/src/scaffold.ts",
    pointer: "/contracts/lesto/scaffoldDepRange",
    extract: (text) => matchValue(/LESTO_DEP_RANGE\s*=\s*["']([^"']+)["']/u, text),
  },
];

function verifyPinnedFacts(
  manifest: RecordValue,
  snapshots: ReadonlyMap<string, RepositorySnapshot>,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const repos = manifest.repos as RecordValue[];
  const check = (pointer: string, extracted: unknown): void => {
    const claimed = pointerValue(manifest, pointer);
    if (extracted === undefined)
      findings.push(
        finding("pinned-content", pointer, "extractable pinned-source fact", "missing"),
      );
    else if (claimed !== extracted)
      findings.push(finding("pinned-content", pointer, extracted, claimed));
  };
  for (const extractor of pinnedExtractors) {
    const snapshot = snapshots.get(extractor.repo)!;
    const repo = repos.find((candidate) => candidate.name === extractor.repo)!;
    const bytes = snapshot.readPinnedFile(String(repo.head), extractor.path);
    check(
      extractor.pointer,
      bytes === null ? undefined : extractor.extract(new TextDecoder().decode(bytes)),
    );
  }
  const lestoSnapshot = snapshots.get("lesto")!;
  const lestoRepo = repos.find((repo) => repo.name === "lesto")!;
  const packageFiles = lestoSnapshot.listPinnedFiles(String(lestoRepo.head), "packages");
  check(
    "/contracts/lesto/packageCount",
    packageFiles?.filter((path) => /^packages\/[^/]+\/package\.json$/u.test(path)).length,
  );
  const snackdaySnapshot = snapshots.get("snackday")!;
  const snackdayRepo = repos.find((repo) => repo.name === "snackday")!;
  const packageBytes = snackdaySnapshot.readPinnedFile(
    String(snackdayRepo.head),
    "apps/web/package.json",
  );
  const apps = manifest.apps as RecordValue[];
  const appIndex = apps.findIndex((candidate) => candidate.name === "snackday-web");
  const app = apps[appIndex];
  if (app === undefined) {
    findings.push(finding("pinned-content", "/apps", "snackday-web pinned app", "missing"));
  } else if (packageBytes === null) {
    findings.push(
      finding(
        "pinned-content",
        `/apps/${appIndex}/lestoDepRange`,
        "apps/web/package.json",
        "missing",
      ),
    );
  } else {
    try {
      const packageJson = JSON.parse(new TextDecoder().decode(packageBytes)) as RecordValue;
      const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
      const ranges = new Set(
        Object.entries(dependencies)
          .filter(([name]) => name.startsWith("@lesto/"))
          .map(([, range]) => range),
      );
      check(`/apps/${appIndex}/lestoDepRange`, ranges.size === 1 ? [...ranges][0] : undefined);
      const config = snackdaySnapshot.readPinnedFile(
        String(snackdayRepo.head),
        String(app.wranglerConfig),
      );
      if (config === null)
        findings.push(
          finding(
            "pinned-content",
            `/apps/${appIndex}/wranglerConfig`,
            "committed file",
            app.wranglerConfig,
          ),
        );
    } catch {
      findings.push(
        finding(
          "pinned-content",
          `/apps/${appIndex}/lestoDepRange`,
          "valid package JSON",
          "invalid",
        ),
      );
    }
  }
  return findings;
}

export function verifyManifest(options: VerifyManifestOptions): VerificationResult {
  const failures: VerificationFinding[] = [];
  const warnings: VerificationFinding[] = [];
  let bytes: Uint8Array;
  let digestText: string;
  try {
    bytes = readFileSync(options.manifestPath);
    digestText = readFileSync(
      options.digestPath ?? `${options.manifestPath}.sha256`,
      "utf8",
    ).trim();
  } catch (error) {
    return {
      ok: false,
      exitCode: 10,
      findings: [
        finding(
          "environment",
          "",
          "readable manifest and digest",
          error instanceof Error ? error.message : error,
        ),
      ],
      warnings,
    };
  }
  const digestMatch = /^([0-9a-f]{64})  (.+)$/.exec(digestText);
  const expectedDigestName = basename(options.manifestPath);
  if (
    digestMatch === null ||
    digestMatch[1] !== sha256(bytes) ||
    digestMatch[2] !== expectedDigestName
  ) {
    return {
      ok: false,
      exitCode: 4,
      findings: [finding("digest", "", `${sha256(bytes)}  ${expectedDigestName}`, digestText)],
      warnings,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {
      ok: false,
      exitCode: 2,
      findings: [
        finding("schema", "", "valid JSON", error instanceof Error ? error.message : error),
      ],
      warnings,
    };
  }
  try {
    if (canonicalize(parsed) !== new TextDecoder().decode(bytes))
      return {
        ok: false,
        exitCode: 3,
        findings: [
          finding(
            "canonical",
            "",
            "RFC 8785 canonical bytes without trailing newline",
            "non-canonical bytes",
          ),
        ],
        warnings,
      };
  } catch (error) {
    return {
      ok: false,
      exitCode: 3,
      findings: [
        finding(
          "canonical",
          "",
          "canonical JSON subset",
          error instanceof Error ? error.message : error,
        ),
      ],
      warnings,
    };
  }
  const schemaFailures = validateSchema(parsed);
  if (schemaFailures.length > 0)
    return { ok: false, exitCode: 2, findings: schemaFailures, warnings };
  const manifest = parsed as RecordValue;
  const repos = manifest.repos as RecordValue[];
  const expectedRepoNames = ["lesto", "roof", "snackday", "studio"];
  const repoNames = repos.map((repo) => String(repo.name));
  if (canonicalize(repoNames) !== canonicalize(expectedRepoNames))
    return {
      ok: false,
      exitCode: 2,
      findings: [finding("schema", "/repos", expectedRepoNames, repoNames)],
      warnings,
    };
  const snapshots = new Map<string, RepositorySnapshot>();
  const inspector = options.inspectRepository ?? inspectGitRepository;
  for (const [index, repo] of repos.entries()) {
    try {
      const snapshot = inspector(String(repo.path), String(repo.head));
      snapshots.set(String(repo.name), snapshot);
      if (!snapshot.objectExists)
        failures.push(
          finding("environment", `/repos/${index}/head`, "commit object present", repo.head),
        );
    } catch (error) {
      failures.push(
        finding(
          "environment",
          `/repos/${index}/path`,
          "readable git worktree",
          error instanceof Error ? error.message : error,
        ),
      );
    }
  }
  if (failures.length > 0) return { ok: false, exitCode: 10, findings: failures, warnings };
  const consistency: VerificationFinding[] = [];
  const enforceSelectedKeys = (
    pointer: string,
    items: readonly RecordValue[],
    key: "component" | "field" | "name",
    exact?: readonly string[],
  ): void => {
    const actual = items.map((item) => String(item[key]));
    const expected = exact === undefined ? [...new Set(actual)].sort() : [...exact];
    if (canonicalize(actual) !== canonicalize(expected))
      consistency.push(finding("consistency", pointer, expected, actual));
  };
  enforceSelectedKeys("/repos", repos, "name", expectedRepoNames);
  enforceSelectedKeys("/apps", manifest.apps as RecordValue[], "name");
  enforceSelectedKeys(
    "/rollback",
    manifest.rollback as RecordValue[],
    "component",
    expectedRepoNames,
  );
  enforceSelectedKeys("/unknowns", manifest.unknowns as RecordValue[], "field");
  const unknowns = (manifest.unknowns as RecordValue[]).map((item) => String(item.field));
  const nulls = collectNullPointers(manifest);
  for (const pointer of nulls)
    if (!unknowns.includes(pointer))
      consistency.push(finding("consistency", pointer, "matching unknowns entry", null));
  for (const pointer of unknowns)
    if (!nulls.includes(pointer))
      consistency.push(
        finding("consistency", pointer, "pointer to null value", pointerValue(manifest, pointer)),
      );
  for (const [index, repo] of (manifest.repos as RecordValue[]).entries()) {
    const upstream = repo.upstream as RecordValue | null;
    const dirty = repo.dirty as RecordValue;
    const durable =
      upstream !== null &&
      upstream.configured === true &&
      upstream.ahead === 0 &&
      dirty.clean === true;
    if (repo.durable !== durable)
      consistency.push(finding("consistency", `/repos/${index}/durable`, durable, repo.durable));
  }
  const contracts = manifest.contracts as RecordValue;
  const lesto = contracts.lesto as RecordValue;
  const compatibility =
    lesto.deployJsonSchemaVersion === lesto.studioConsumerPinnedVersion
      ? "consistent"
      : "inconsistent";
  if (lesto.compatStatus !== compatibility)
    consistency.push(
      finding("consistency", "/contracts/lesto/compatStatus", compatibility, lesto.compatStatus),
    );
  const timestamps = [...snapshots.values()]
    .map((snapshot) => normalizeTimestamp(snapshot.commitTimestamp))
    .sort();
  if (manifest.generatedAt !== timestamps.at(-1))
    consistency.push(
      finding("consistency", "/generatedAt", timestamps.at(-1), manifest.generatedAt),
    );
  if (consistency.length > 0) return { ok: false, exitCode: 7, findings: consistency, warnings };
  const pinned: VerificationFinding[] = verifyPinnedFacts(manifest, snapshots);
  for (const [repoName, filePath, pointer] of knownPinnedHashes) {
    const snapshot = snapshots.get(repoName);
    const repo = (manifest.repos as RecordValue[]).find((item) => item.name === repoName);
    if (snapshot === undefined || repo === undefined) {
      pinned.push(finding("pinned-content", pointer, `required repository ${repoName}`, "missing"));
      continue;
    }
    const content = snapshot.readPinnedFile(String(repo.head), filePath);
    if (content === null)
      pinned.push(finding("pinned-content", pointer, "committed file", "missing"));
    else if (pointerValue(manifest, pointer) !== sha256(content))
      pinned.push(
        finding("pinned-content", pointer, sha256(content), pointerValue(manifest, pointer)),
      );
  }
  if (pinned.length > 0) return { ok: false, exitCode: 6, findings: pinned, warnings };
  const drift: VerificationFinding[] = [];
  for (const [index, repo] of (manifest.repos as RecordValue[]).entries()) {
    const snapshot = snapshots.get(String(repo.name))!;
    if (repo.head !== snapshot.head)
      drift.push(finding("drift", `/repos/${index}/head`, repo.head, snapshot.head));
    if (repo.branch !== snapshot.branch)
      drift.push(finding("drift", `/repos/${index}/branch`, repo.branch, snapshot.branch));
    if (canonicalize(repo.upstream) !== canonicalize(snapshot.upstream))
      drift.push(finding("drift", `/repos/${index}/upstream`, repo.upstream, snapshot.upstream));
    if (repo.latestTag !== snapshot.latestTag)
      drift.push(finding("drift", `/repos/${index}/latestTag`, repo.latestTag, snapshot.latestTag));
    const dirty = repo.dirty as RecordValue;
    if (dirty.fileCount !== snapshot.dirtyFileCount)
      warnings.push(
        finding(
          "drift",
          `/repos/${index}/dirty/fileCount`,
          dirty.fileCount,
          snapshot.dirtyFileCount,
        ),
      );
  }
  return {
    ok: drift.length === 0,
    exitCode: drift.length === 0 ? 0 : 5,
    findings: drift,
    warnings,
  };
}

export function formatVerificationFinding(item: VerificationFinding, index: number): string {
  return `FAIL ${item.phase}.${index + 1} ${item.pointer || "/"}: expected ${item.expected} actual ${item.actual}`;
}

export function defaultDigestPath(manifestPath: string): string {
  return resolve(dirname(manifestPath), `${basename(manifestPath)}.sha256`);
}
