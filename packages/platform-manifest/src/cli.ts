import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { canonicalize, normalizeTimestamp, writeManifest } from "./index";
import { collectLocalFacts } from "./local-facts";
import { verifyManifest } from "./verify";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function printResult(label: string, exitCode: number): void {
  console.log(`${label}: exit=${exitCode}`);
}

async function generate(path: string): Promise<void> {
  await writeManifest(path, collectLocalFacts());
  console.log(path);
}

function verify(path: string): number {
  const result = verifyManifest({ manifestPath: path });
  for (const item of result.findings)
    console.error(
      `FAIL ${item.phase} ${item.pointer}: expected ${item.expected} actual ${item.actual}`,
    );
  for (const item of result.warnings)
    console.warn(
      `WARN ${item.phase} ${item.pointer}: expected ${item.expected} actual ${item.actual}`,
    );
  return result.exitCode;
}

function git(path: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(["git", "-C", path, ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${arguments_.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function missingCommit(path: string): string {
  for (const character of ["0", "f", "e", "d"]) {
    const candidate = character.repeat(40);
    const result = Bun.spawnSync(["git", "-C", path, "cat-file", "-e", `${candidate}^{commit}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return candidate;
  }
  throw new Error("Could not construct a missing 40-character commit identifier");
}

function alternateStudioCommit(value: Record<string, any>): string {
  const studio = value["repos"].find((repo: { name: string }) => repo.name === "studio");
  const currentHash = value["contracts"].studio.openapiSha256 as string;
  const commits = git(studio.path, "rev-list", studio.head, "--", "api/openapi.json").split("\n");
  for (const commit of commits.slice(1)) {
    const content = Bun.spawnSync(
      ["git", "-C", studio.path, "show", `${commit}:api/openapi.json`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (content.exitCode === 0 && sha256(content.stdout) !== currentHash) return commit;
  }
  throw new Error("No existing Studio commit with different pinned OpenAPI content was found");
}

function updateGeneratedAt(value: Record<string, any>): void {
  const timestamps = value["repos"]
    .map((repo: { path: string; head: string }) =>
      normalizeTimestamp(git(repo.path, "show", "-s", "--format=%cI", repo.head)),
    )
    .toSorted();
  value["generatedAt"] = timestamps.at(-1);
}

function prepareDriftClone(value: Record<string, any>, directory: string): string {
  const snackday = value["repos"].find((repo: { name: string }) => repo.name === "snackday");
  const clonePath = join(directory, "snackday-drift");
  const clone = Bun.spawnSync(["git", "clone", "--shared", snackday.path, clonePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (clone.exitCode !== 0) throw new Error(clone.stderr.toString().trim());
  git(clonePath, "config", "user.name", "Manifest Tamper Suite");
  git(clonePath, "config", "user.email", "manifest-suite.invalid@example.invalid");
  git(clonePath, "commit", "--allow-empty", "-m", "world drift control");
  return clonePath;
}

async function tamper(original: string): Promise<number> {
  const originalVerification = verifyManifest({ manifestPath: original });
  if (!originalVerification.ok) {
    console.error(
      `tamper-suite: source manifest must verify first; aborting at exit=${originalVerification.exitCode}`,
    );
    return originalVerification.exitCode;
  }
  const directory = await mkdtemp(join(tmpdir(), "platform-manifest-tamper-"));
  const raw = await readFile(original, "utf8");
  const originalValue = JSON.parse(raw) as Record<string, any>;
  const driftClone = prepareDriftClone(originalValue, directory);
  const cases: Array<{
    name: string;
    expected: number;
    mutate: (value: Record<string, any>) => void;
    transform?: (bytes: string) => string;
  }> = [
    {
      name: "pinned-openapi-hash",
      expected: 6,
      mutate: (value) => {
        const hash = value["contracts"].studio.openapiSha256 as string;
        value["contracts"].studio.openapiSha256 = `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
      },
    },
    {
      name: "non-canonical-indentation",
      expected: 3,
      mutate: () => {},
      transform: (bytes) => `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`,
    },
    { name: "signed-claim", expected: 2, mutate: (value) => (value["signed"] = true) },
    {
      name: "authorization-receipt-claim",
      expected: 2,
      mutate: (value) =>
        (value["authorization"].mergeReceipts = {
          head: value["repos"][0].head,
          decision: "allow",
        }),
    },
    {
      name: "truncated-head",
      expected: 2,
      mutate: (value) => (value["repos"][0].head = value["repos"][0].head.slice(0, 12)),
    },
    {
      name: "missing-valid-head",
      expected: 10,
      mutate: (value) => {
        const lesto = value["repos"].find((repo: { name: string }) => repo.name === "lesto");
        lesto.head = missingCommit(lesto.path);
      },
    },
    {
      name: "alternate-existing-head",
      expected: 6,
      mutate: (value) => {
        const studio = value["repos"].find((repo: { name: string }) => repo.name === "studio");
        studio.head = alternateStudioCommit(value);
        updateGeneratedAt(value);
      },
    },
    {
      name: "missing-null-ledger-entry",
      expected: 7,
      mutate: (value) =>
        (value["unknowns"] = value["unknowns"].filter(
          (item: { field: string }) => item.field !== "/authorization/mergeReceipts",
        )),
    },
    {
      name: "incompatible-status-lie",
      expected: 7,
      mutate: (value) => {
        value["contracts"].lesto.deployJsonSchemaVersion = 2;
      },
    },
    {
      name: "pinned-deploy-version-lie",
      expected: 6,
      mutate: (value) => {
        value["contracts"].lesto.deployJsonSchemaVersion = 2;
        value["contracts"].lesto.compatStatus = "inconsistent";
      },
    },
    {
      name: "world-drift-clone",
      expected: 5,
      mutate: (value) => {
        const snackday = value["repos"].find((repo: { name: string }) => repo.name === "snackday");
        snackday.path = driftClone;
      },
    },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const value = structuredClone(originalValue);
    testCase.mutate(value);
    const path = join(directory, `${testCase.name}.json`);
    const bytes = testCase.transform?.(canonicalize(value)) ?? canonicalize(value);
    await writeFile(path, bytes);
    await writeFile(`${path}.sha256`, `${sha256(bytes)}  ${basename(path)}`);
    const actual = verifyManifest({ manifestPath: path }).exitCode;
    printResult(testCase.name, actual);
    if (actual !== testCase.expected) failures += 1;
  }
  const digestPath = join(directory, "digest-mismatch.json");
  await copyFile(original, digestPath);
  await writeFile(`${digestPath}.sha256`, `${"0".repeat(64)}  ${basename(digestPath)}`);
  const digestExit = verifyManifest({ manifestPath: digestPath }).exitCode;
  printResult("digest-mismatch", digestExit);
  if (digestExit !== 4) failures += 1;
  const total = cases.length + 1;
  console.log(`tamper-suite: ${total - failures}/${total} exact expected failures`);
  return failures === 0 ? 0 : 1;
}

const [command = "", argument] = Bun.argv.slice(2);
const defaultPath = resolve("platform-manifest-v0.json");
let exitCode = 0;
if (command === "generate") await generate(resolve(argument ?? defaultPath));
else if (command === "verify") exitCode = verify(resolve(argument ?? defaultPath));
else if (command === "tamper") exitCode = await tamper(resolve(argument ?? defaultPath));
else {
  console.error("usage: bun src/cli.ts generate|verify|tamper [manifest-path]");
  exitCode = 10;
}
process.exitCode = exitCode;
