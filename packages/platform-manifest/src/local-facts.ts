import { createHash } from "node:crypto";

import type { ManifestFacts, RepoFact } from "./index";
import { inspectGitRepository } from "./verify";

export const LOCAL_REPOSITORIES = {
  lesto: "/Users/ryan/crack",
  roof: "/Users/ryan/src",
  snackday: "/Users/ryan/snackday",
  studio: "/Users/ryan/every-io/studio",
} as const;

type RepositoryName = keyof typeof LOCAL_REPOSITORIES;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function git(path: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
}

function pinnedBytes(name: RepositoryName, file: string): Uint8Array {
  const result = Bun.spawnSync(["git", "-C", LOCAL_REPOSITORIES[name], "show", `HEAD:${file}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `Could not read pinned ${name}:${file}`);
  }
  return result.stdout;
}

function pinnedText(name: RepositoryName, file: string): string {
  return new TextDecoder().decode(pinnedBytes(name, file));
}

function extract(text: string, expression: RegExp, label: string): string {
  const value = expression.exec(text)?.[1];
  if (value === undefined) throw new Error(`Could not extract ${label} from pinned source`);
  return value;
}

function remote(path: string): string | null {
  try {
    return git(path, "remote", "get-url", "origin");
  } catch {
    return null;
  }
}

const repoPolicy: Record<
  RepositoryName,
  Pick<RepoFact, "tagsAuthoritative" | "releasePipeline" | "gateCommand" | "gateEnforcedInCI">
> = {
  lesto: {
    tagsAuthoritative: false,
    releasePipeline: "dispatch-only",
    gateCommand: "bun run gate",
    gateEnforcedInCI: true,
  },
  roof: {
    tagsAuthoritative: false,
    releasePipeline: "tag-push",
    gateCommand: "swift test && scripts/check-fixture-freshness.sh",
    gateEnforcedInCI: true,
  },
  snackday: {
    tagsAuthoritative: false,
    releasePipeline: "none",
    gateCommand: "bun run gate",
    gateEnforcedInCI: false,
  },
  studio: {
    tagsAuthoritative: false,
    releasePipeline: "tag-push",
    gateCommand: "bun run typecheck && bun run lint && bun run test && bun run test:e2e",
    gateEnforcedInCI: true,
  },
};

function collectRepo(name: RepositoryName): RepoFact {
  const path = LOCAL_REPOSITORIES[name];
  const head = git(path, "rev-parse", "HEAD");
  const snapshot = inspectGitRepository(path, head);
  return {
    name,
    path,
    head,
    committedAt: snapshot.commitTimestamp,
    branch: snapshot.branch,
    remote: remote(path),
    upstream: snapshot.upstream,
    dirty: { clean: snapshot.dirtyFileCount === 0, fileCount: snapshot.dirtyFileCount },
    latestTag: snapshot.latestTag,
    ...repoPolicy[name],
  };
}

export function collectLocalFacts(): ManifestFacts {
  const studioOpenapi = pinnedBytes("studio", "api/openapi.json");
  const studioEvents = pinnedBytes("studio", "shared/src/event.ts");
  const snackdayPackage = JSON.parse(pinnedText("snackday", "apps/web/package.json")) as {
    dependencies: Record<string, string>;
  };
  const lestoRanges = new Set(
    Object.entries(snackdayPackage.dependencies)
      .filter(([name]) => name.startsWith("@lesto/"))
      .map(([, range]) => range),
  );
  if (lestoRanges.size !== 1) throw new Error("Snackday must use one @lesto dependency range");
  const repos = (Object.keys(LOCAL_REPOSITORIES) as RepositoryName[]).map(collectRepo);
  const nullUnknowns: Array<[string, string]> = [
    ["/apps/0/deployedVersion", "DEPLOYED_VERSION_NOT_LOCALLY_VERIFIED"],
    ["/apps/0/migrationVersions", "MIGRATION_VERSIONS_NOT_EXTRACTED"],
    ["/authorization/mergeReceipts", "NO_AUTHORIZATION_LEDGER"],
    ["/contracts/lesto/npmSurfaceVersion", "REMOTE_TRUTH_UNVERIFIED"],
    ["/contracts/templateContractVersion", "NO_TEMPLATE_CONTRACT"],
    ["/releases/roof", "NO_TAGGED_RELEASE_EVER_CUT"],
    ["/releases/studio", "NO_TAGGED_RELEASE_EVER_CUT"],
  ];
  for (const [index, repo] of [...repos].sort((a, b) => a.name.localeCompare(b.name)).entries()) {
    if (repo.latestTag === null) nullUnknowns.push([`/repos/${index}/latestTag`, "NO_LOCAL_TAG"]);
    if (repo.remote === null) nullUnknowns.push([`/repos/${index}/remote`, "NO_REMOTE"]);
    if (repo.upstream === null) nullUnknowns.push([`/repos/${index}/upstream`, "NO_UPSTREAM"]);
  }
  const packageCount = git(
    LOCAL_REPOSITORIES.lesto,
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    "packages",
  )
    .split("\n")
    .filter((path) => /^packages\/[^/]+\/package\.json$/u.test(path)).length;
  return {
    generatorVersion: "0.0.0",
    repos,
    contracts: {
      studio: {
        apiContractVersion: extract(
          pinnedText("studio", "shared/src/contract-version.ts"),
          /API_CONTRACT_VERSION\s*=\s*["']([^"']+)["']/u,
          "Studio API contract version",
        ),
        openapiSha256: sha256(studioOpenapi),
        wsEventSchemaSha256: sha256(studioEvents),
        dbSchemaVersion: Number(
          extract(
            pinnedText("studio", "api/src/db/index.ts"),
            /SCHEMA_VERSION\s*=\s*(\d+)/u,
            "Studio database schema version",
          ),
        ),
      },
      lesto: {
        deployJsonSchemaVersion: Number(
          extract(
            pinnedText("lesto", "packages/cli/src/run.ts"),
            /DEPLOY_JSON_SCHEMA_VERSION\s*=\s*(\d+)/u,
            "Lesto deploy JSON schema version",
          ),
        ),
        studioConsumerPinnedVersion: Number(
          extract(
            pinnedText("studio", "api/src/services/lesto-deploy.ts"),
            /schemaVersion\s*:\s*z\.literal\((\d+)\)/u,
            "Studio Lesto schema pin",
          ),
        ),
        npmSurfaceVersion: null,
        scaffoldDepRange: extract(
          pinnedText("lesto", "packages/create-lesto/src/scaffold.ts"),
          /LESTO_DEP_RANGE\s*=\s*["']([^"']+)["']/u,
          "Lesto scaffold dependency range",
        ),
        packageCount,
      },
    },
    releases: {
      studio: null,
      roof: null,
      lesto: { channel: "npm", version: "0.2.0", locallyVerified: false },
      reasonForNulls: "NO_TAGGED_RELEASE_EVER_CUT",
    },
    rollback: [
      { component: "lesto", mechanism: "pointer-flip", scripted: true, everExercised: true },
      {
        component: "roof",
        mechanism: "appcast-repoint-unscripted",
        scripted: false,
        everExercised: false,
      },
      { component: "snackday", mechanism: "unknown", scripted: false, everExercised: false },
      {
        component: "studio",
        mechanism: "undocumented-manual",
        scripted: false,
        everExercised: false,
      },
    ],
    apps: [
      {
        name: "snackday-web",
        lestoDepRange: [...lestoRanges][0]!,
        wranglerConfig: "apps/web/wrangler.jsonc",
        deployedVersion: null,
        migrationVersions: null,
      },
    ],
    unknowns: nullUnknowns.map(([field, reason]) => ({ field, reason })),
  };
}
