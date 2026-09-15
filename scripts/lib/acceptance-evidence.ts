import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { xcodeEnvironment } from "./dev-scenario-ios";

/** Logs belong to synthetic local runs only; never retain the database or headers. */
export function redactAcceptanceLog(value: string): string {
  return value
    .replace(
      /\b(?:x-lesto-dev-token|authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/giu,
      "[redacted credential header]",
    )
    .replace(/\bBearer\s+[^\s"')]+/giu, "Bearer [redacted]")
    .replace(/(?:__Host-snackday_session|snackday_session_dev)=[^\s;"']+/gu, "session=[redacted]")
    .replace(/\/invite#[^\s"'<>)]*/giu, "/invite#[redacted]")
    .replace(
      /\b(?:token|identityToken|nonce|secret|password)\b["']?\s*[:=]\s*["']?[^\s,"'}]+/giu,
      "credential=[redacted]",
    )
    .replace(/\b[0-9a-f]{64}\b/giu, "[redacted credential]");
}

function command(root: string, executable: string, args: string[]): string | null {
  try {
    return execFileSync(executable, args, {
      cwd: root,
      ...(executable === "xcodebuild" ? { env: xcodeEnvironment() } : {}),
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export interface AcceptanceProvenance {
  readonly commit: string | null;
  readonly dirty: boolean | null;
  readonly bun: string;
  readonly xcode: string | null;
  readonly platform: string;
}

export function acceptanceProvenance(root: string): AcceptanceProvenance {
  const status = command(root, "git", ["status", "--porcelain"]);
  return {
    commit: command(root, "git", ["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    bun: Bun.version,
    xcode: process.platform === "darwin" ? command(root, "xcodebuild", ["-version"]) : null,
    platform: `${process.platform}-${process.arch}`,
  };
}

export async function writeAcceptanceEvidence(input: {
  readonly root: string;
  readonly scratchDir: string | undefined;
  readonly startedAt: string;
  readonly failedStep: string | null;
  readonly provenance: AcceptanceProvenance;
  readonly cleanup?: () => Promise<void>;
}): Promise<string> {
  let cleanupError: Error | undefined;
  let cleanupFailed = false;
  let logs: readonly { name: string; content: string | null }[] = [];
  try {
    if (input.scratchDir !== undefined) {
      const scratchDir = input.scratchDir;
      logs = await Promise.all(
        ["web-server.stdout.log", "web-server.stderr.log", "xcodebuild.log"].map(async (name) => {
          const content = await readFile(join(scratchDir, name), "utf8").catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          });
          return { name, content };
        }),
      );
    }
  } finally {
    try {
      await input.cleanup?.();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const failedStep = input.failedStep ?? (cleanupFailed ? "scratch-cleanup" : null);
  const output = join(input.root, ".artifacts", "acceptance");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "run-"));
  const artifacts: string[] = [];
  if (failedStep !== null) {
    for (const { name, content } of logs) {
      if (content === null) continue;
      await writeFile(join(directory, name), redactAcceptanceLog(content), { mode: 0o600 });
      artifacts.push(name);
    }
  }
  await writeFile(
    join(directory, "receipt.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scope: "acceptance",
        status: failedStep === null ? "passed" : "failed",
        startedAt: input.startedAt,
        finishedAt: new Date().toISOString(),
        failedStep,
        ...input.provenance,
        artifacts,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const receipt = relative(input.root, join(directory, "receipt.json"));
  if (cleanupError !== undefined) {
    throw new Error(`${cleanupError.message}; acceptance evidence: ${receipt}`, {
      cause: cleanupError,
    });
  }
  return receipt;
}
