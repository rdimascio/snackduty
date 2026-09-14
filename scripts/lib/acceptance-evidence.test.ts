import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactAcceptanceLog, writeAcceptanceEvidence } from "./acceptance-evidence";

test("acceptance logs redact credentials while retaining diagnostic lines", () => {
  const input = [
    "lesto dev: MCP control plane on http://127.0.0.1:3001/ (x-lesto-dev-token: mcp-private)",
    "Cookie: snackday_session_dev=session-private",
    "Authorization: Bearer auth-private",
    'headers {"cookie":"json-cookie-private"}',
    "snackday_session_dev=standalone-private; Path=/",
    'payload {"token":"json-private"}',
    "GET /invite#fragment-private",
    "GET /calendar/" + "a".repeat(64) + ".ics",
    "SQLITE_BUSY: database is locked",
    "Test liveDevServerRoundTrip passed",
  ].join("\n");
  const output = redactAcceptanceLog(input);
  for (const secret of [
    "mcp-private",
    "session-private",
    "auth-private",
    "json-cookie-private",
    "standalone-private",
    "json-private",
    "fragment-private",
    "a".repeat(64),
  ]) {
    expect(output).not.toContain(secret);
  }
  expect(output).toContain("SQLITE_BUSY: database is locked");
  expect(output).toContain("Test liveDevServerRoundTrip passed");
});

test("failure receipts retain complete redacted allowlisted logs, never database files", async () => {
  const root = await mkdtemp(join(tmpdir(), "snackday-evidence-test-"));
  try {
    const scratchDir = join(root, "scratch");
    await mkdir(scratchDir);
    await writeFile(
      join(scratchDir, "web-server.stdout.log"),
      "first diagnostic\n".repeat(100) + "Cookie: private\nlast diagnostic",
    );
    await writeFile(join(scratchDir, "acceptance.db"), "must never be copied");
    const provenance = {
      commit: "test-commit",
      dirty: true,
      bun: "test",
      xcode: null,
      platform: "test",
    };
    const receiptPath = await writeAcceptanceEvidence({
      root,
      scratchDir,
      startedAt: "2026-09-14T00:00:00.000Z",
      failedStep: "server-readiness",
      provenance,
    });
    const receipt = JSON.parse(await readFile(join(root, receiptPath), "utf8"));
    expect(receipt.status).toBe("failed");
    expect(receipt.scope).toBe("acceptance");
    expect(receipt.failedStep).toBe("server-readiness");
    expect(receipt.commit).toBe("test-commit");
    expect(receipt.artifacts).toEqual(["web-server.stdout.log"]);
    const directory = join(root, receiptPath, "..");
    expect((await readdir(directory)).sort()).toEqual(["receipt.json", "web-server.stdout.log"]);
    const log = await readFile(join(directory, "web-server.stdout.log"), "utf8");
    expect(log.startsWith("first diagnostic\n")).toBe(true);
    expect(log.endsWith("last diagnostic")).toBe(true);
    expect(log).not.toContain("private");
    expect(log.match(/first diagnostic/gu)?.length).toBe(100);

    const successPath = await writeAcceptanceEvidence({
      root,
      scratchDir,
      startedAt: "2026-09-14T00:00:00.000Z",
      failedStep: null,
      provenance,
    });
    expect(successPath).not.toBe(receiptPath);
    const success = JSON.parse(await readFile(join(root, successPath), "utf8"));
    expect(success.status).toBe("passed");
    expect(success.artifacts).toEqual([]);
    expect(await readdir(join(root, successPath, ".."))).toEqual(["receipt.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cleanup error cannot leave a passing receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "snackday-evidence-cleanup-test-"));
  try {
    await expect(
      writeAcceptanceEvidence({
        root,
        scratchDir: undefined,
        startedAt: "2026-09-14T00:00:00.000Z",
        failedStep: null,
        provenance: { commit: "test", dirty: false, bun: "test", xcode: null, platform: "test" },
        cleanup: () => Promise.reject(new Error("synthetic cleanup failure")),
      }),
    ).rejects.toThrow("synthetic cleanup failure");
    const directory = join(root, ".artifacts", "acceptance");
    const [run] = await readdir(directory);
    if (run === undefined) throw new Error("cleanup failure receipt is missing");
    const receipt = JSON.parse(await readFile(join(directory, run, "receipt.json"), "utf8"));
    expect(receipt.status).toBe("failed");
    expect(receipt.failedStep).toBe("scratch-cleanup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
