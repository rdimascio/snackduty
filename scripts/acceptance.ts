/**
 * Milestone 1 acceptance journey — `bun run accept`.
 *
 * Boots the real web app as a child process on an ephemeral port with a scratch
 * SQLite database and the development sign-in enabled, then drives the FULL
 * adult journey over real HTTP: dev sign-in → create team → create season →
 * add a child participant (with birth date) → attach two guardians with
 * different relationships → read the team list and roster back through the
 * authorized APIs → verify the /app page renders the real roster server-side
 * (and leaks no identifiers) → verify the signed-out /app page shows none of
 * it. Finally it runs the env-gated iOS live round trip (SnackdayDomainTests)
 * against the SAME running server and refuses to accept a skipped run.
 *
 * The server is torn down and the scratch database removed even on failure;
 * any assertion failure exits nonzero naming the failing step.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const TEAM_NAME = "Acceptance Falcons";
const SEASON = {
  label: "Spring 2026 Acceptance",
  startDate: "2026-03-01",
  endDate: "2026-06-01",
  timeZone: "America/Los_Angeles",
} as const;
const CHILD = { displayName: "Rowan Acceptance", birthDate: "2019-05-14" } as const;
const GUARDIAN_ONE = { displayName: "Jordan Acceptance", relationship: "parent" } as const;
const GUARDIAN_TWO = {
  displayName: "Sasha Acceptance",
  relationship: "caregiver",
  permissions: ["participant.read"],
} as const;
const DEFAULT_GUARDIAN_PERMISSIONS = ["participant.read", "participant.manage"] as const;
const REAL_NAMES = [
  TEAM_NAME,
  CHILD.displayName,
  GUARDIAN_ONE.displayName,
  GUARDIAN_TWO.displayName,
] as const;
// Substrings that must never appear in the rendered /app HTML: credential-ish
// vocabulary plus the internal identifiers of the dev fixture and the session.
const FORBIDDEN_APP_HTML = [
  "email",
  "token",
  "person_dev_adult",
  "account_dev_adult",
  "snackday_session_dev",
  "createdByPersonId",
] as const;

class StepFailure extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

function fail(step: string, message: string): never {
  throw new StepFailure(step, message);
}

function ensure(step: string, condition: boolean, message: string): asserts condition {
  if (!condition) fail(step, message);
}

/** Bind port 0 to let the OS pick a free port, then release it for the server. */
function reserveEphemeralPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  ensure("reserve-port", typeof port === "number" && port > 0, "could not reserve a free port");
  return port;
}

interface WebServer {
  readonly process: Subprocess;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

function bootWebServer(port: number, dbPath: string, scratchDir: string): WebServer {
  const stdoutLog = join(scratchDir, "web-server.stdout.log");
  const stderrLog = join(scratchDir, "web-server.stderr.log");
  const child = Bun.spawn({
    cmd: ["bun", "--bun", "lesto", "dev", "--port", String(port)],
    cwd: join(ROOT, "apps", "web"),
    env: { ...process.env, LESTO_DB: dbPath, SNACKDAY_DEV_SIGN_IN: "true" },
    stdout: Bun.file(stdoutLog),
    stderr: Bun.file(stderrLog),
  });
  return { process: child, stdoutLog, stderrLog };
}

async function stopWebServer(server: WebServer): Promise<void> {
  const child = server.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const outcome = await Promise.race([
    child.exited.then(() => "exited" as const),
    Bun.sleep(5_000).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    child.kill(9);
    await child.exited;
  }
}

/** The dev-session probe doubles as the readiness gate AND the flag check: the
 * route only exists when SNACKDAY_DEV_SIGN_IN reached the server, and it must
 * answer 401 before any sign-in. */
async function waitForReadiness(base: string, server: WebServer): Promise<void> {
  const step = "server-readiness";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.process.exitCode !== null) {
      fail(step, `web server exited early with code ${server.process.exitCode}`);
    }
    try {
      const response = await fetch(`${base}/api/dev/session`);
      ensure(
        step,
        response.status === 401,
        `expected 401 from GET /api/dev/session before sign-in, got ${response.status}`,
      );
      return;
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      await Bun.sleep(250);
    }
  }
  fail(step, "web server did not answer GET /api/dev/session within 30s");
}

async function requestJson(
  step: string,
  url: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  ensure(
    step,
    response.status === expectedStatus,
    `${init.method ?? "GET"} ${url} answered ${response.status} (expected ${expectedStatus}): ${text}`,
  );
  const parsed: unknown = JSON.parse(text);
  ensure(step, typeof parsed === "object" && parsed !== null, `${url} returned non-object JSON`);
  return parsed as Record<string, unknown>;
}

function mutationHeaders(cookie?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    ...(cookie === undefined ? {} : { Cookie: cookie }),
  };
}

async function signIn(base: string): Promise<string> {
  const step = "dev-sign-in";
  const response = await fetch(`${base}/api/dev/sign-in`, {
    method: "POST",
    // The endpoint rejects any request body; the origin check needs the
    // same-origin fetch metadata on every mutating request.
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  ensure(step, response.status === 200, `POST /api/dev/sign-in answered ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  ensure(
    step,
    setCookie !== null && setCookie.startsWith("snackday_session_dev="),
    `expected a snackday_session_dev Set-Cookie header, got: ${String(setCookie)}`,
  );
  const cookie = setCookie.split(";", 1)[0];
  ensure(
    step,
    cookie !== undefined && cookie.length > "snackday_session_dev=".length,
    "session cookie is empty",
  );
  const identity = (await response.json()) as { person?: { displayName?: string } };
  ensure(
    step,
    identity.person?.displayName === "Development Adult",
    `sign-in identity is not the development adult: ${JSON.stringify(identity)}`,
  );
  return cookie;
}

interface JourneyIds {
  readonly teamId: string;
  readonly seasonId: string;
  readonly participantId: string;
}

async function createTeamSeasonAndRoster(base: string, cookie: string): Promise<JourneyIds> {
  const created = await requestJson(
    "create-team",
    `${base}/api/teams`,
    { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify({ name: TEAM_NAME }) },
    201,
  );
  const team = created["team"] as { id?: string; name?: string };
  ensure("create-team", typeof team?.id === "string", `no team id in ${JSON.stringify(created)}`);
  ensure("create-team", team.name === TEAM_NAME, `team name mismatch: ${String(team.name)}`);
  const teamId = team.id;

  const seasonBody = await requestJson(
    "create-season",
    `${base}/api/teams/${teamId}/seasons`,
    { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify(SEASON) },
    201,
  );
  const season = seasonBody["season"] as { id?: string; label?: string };
  ensure(
    "create-season",
    typeof season?.id === "string",
    `no season id in ${JSON.stringify(seasonBody)}`,
  );
  ensure(
    "create-season",
    season.label === SEASON.label,
    `season label mismatch: ${String(season.label)}`,
  );
  const seasonId = season.id;

  const participantBody = await requestJson(
    "add-participant",
    `${base}/api/teams/${teamId}/seasons/${seasonId}/participants`,
    { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify(CHILD) },
    201,
  );
  const participant = participantBody["participant"] as {
    participantId?: string;
    displayName?: string;
    birthDate?: string;
  };
  ensure(
    "add-participant",
    typeof participant?.participantId === "string",
    `no participantId in ${JSON.stringify(participantBody)}`,
  );
  ensure(
    "add-participant",
    participant.displayName === CHILD.displayName && participant.birthDate === CHILD.birthDate,
    `participant projection mismatch: ${JSON.stringify(participant)}`,
  );
  const participantId = participant.participantId;

  for (const guardian of [GUARDIAN_ONE, GUARDIAN_TWO]) {
    const guardianBody = await requestJson(
      "attach-guardian",
      `${base}/api/participants/${participantId}/guardians`,
      { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify(guardian) },
      201,
    );
    const attached = guardianBody["guardian"] as { displayName?: string; relationship?: string };
    ensure(
      "attach-guardian",
      attached?.displayName === guardian.displayName &&
        attached.relationship === guardian.relationship,
      `guardian projection mismatch: ${JSON.stringify(guardianBody)}`,
    );
  }

  return { teamId, seasonId, participantId };
}

async function verifyTeamList(base: string, cookie: string, ids: JourneyIds): Promise<void> {
  const step = "read-team-list";
  const body = await requestJson(step, `${base}/api/teams`, { headers: { Cookie: cookie } }, 200);
  const teams = body["teams"] as readonly {
    team?: { id?: string; name?: string };
    seasons?: readonly { id?: string; label?: string }[];
  }[];
  ensure(
    step,
    Array.isArray(teams) && teams.length === 1,
    `expected exactly one team: ${JSON.stringify(body)}`,
  );
  const entry = teams[0];
  ensure(
    step,
    entry?.team?.id === ids.teamId && entry.team.name === TEAM_NAME,
    `team list entry mismatch: ${JSON.stringify(entry)}`,
  );
  ensure(
    step,
    entry.seasons?.length === 1 &&
      entry.seasons[0]?.id === ids.seasonId &&
      entry.seasons[0].label === SEASON.label,
    `season list mismatch: ${JSON.stringify(entry?.seasons)}`,
  );
}

async function verifyRoster(base: string, cookie: string, ids: JourneyIds): Promise<void> {
  const step = "read-roster";
  const body = await requestJson(
    step,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/roster`,
    { headers: { Cookie: cookie } },
    200,
  );
  const roster = body["roster"] as readonly {
    participantId?: string;
    displayName?: string;
    birthDate?: string;
    guardians?: readonly {
      guardianId?: string;
      displayName?: string;
      relationship?: string;
      permissions?: readonly string[];
      status?: string;
    }[];
  }[];
  ensure(
    step,
    Array.isArray(roster) && roster.length === 1,
    `expected one roster entry: ${JSON.stringify(body)}`,
  );
  const child = roster[0];
  ensure(
    step,
    child?.participantId === ids.participantId &&
      child.displayName === CHILD.displayName &&
      child.birthDate === CHILD.birthDate,
    `roster child mismatch: ${JSON.stringify(child)}`,
  );
  const guardians = child.guardians ?? [];
  ensure(step, guardians.length === 2, `expected two guardians: ${JSON.stringify(guardians)}`);
  const one = guardians.find((guardian) => guardian.displayName === GUARDIAN_ONE.displayName);
  const two = guardians.find((guardian) => guardian.displayName === GUARDIAN_TWO.displayName);
  ensure(
    step,
    one?.relationship === GUARDIAN_ONE.relationship &&
      one.status === "active" &&
      JSON.stringify(one.permissions) === JSON.stringify(DEFAULT_GUARDIAN_PERMISSIONS),
    `first guardian mismatch: ${JSON.stringify(one)}`,
  );
  ensure(
    step,
    two?.relationship === GUARDIAN_TWO.relationship &&
      two.status === "active" &&
      JSON.stringify(two.permissions) === JSON.stringify(GUARDIAN_TWO.permissions),
    `second guardian mismatch: ${JSON.stringify(two)}`,
  );
  ensure(
    step,
    one.guardianId !== undefined && one.guardianId !== two.guardianId,
    "guardian ids are not distinct",
  );
}

/** `lesto dev` injects its own dev-tooling scripts whose plumbing carries the
 * word "token": the reload WebSocket's `?token=<hex64>` and the MCP control
 * plane's `x-lesto-dev-token` header (plus its hex value). Strip exactly those
 * artifacts so the leak scan stays about APP data — a session token, or any
 * other "token" text, still fails the check. */
function withoutLestoDevTooling(html: string): string {
  return html
    .replaceAll(/\?token=[0-9a-f]{64}/gu, "?dev-hmr-auth")
    .replaceAll("x-lesto-dev-token", "x-lesto-dev-header");
}

async function verifySignedInAppPage(base: string, cookie: string): Promise<void> {
  const step = "app-page-signed-in";
  const response = await fetch(`${base}/app`, { headers: { Cookie: cookie } });
  ensure(step, response.status === 200, `GET /app answered ${response.status}`);
  const html = await response.text();
  // Server rendering separates adjacent text nodes with `<!-- -->` markers
  // (e.g. `(<!-- -->parent<!-- -->)`); collapse them for the content checks.
  const rendered = html.replaceAll("<!-- -->", "");
  ensure(
    step,
    rendered.includes("Team overview"),
    "signed-in /app is missing the team overview heading",
  );
  for (const name of REAL_NAMES) {
    ensure(step, rendered.includes(name), `signed-in /app HTML is missing "${name}"`);
  }
  for (const relationship of [GUARDIAN_ONE.relationship, GUARDIAN_TWO.relationship]) {
    ensure(
      step,
      rendered.includes(`(${relationship})`),
      `guardian relationship "${relationship}" not rendered`,
    );
  }
  ensure(step, rendered.includes(`Born ${CHILD.birthDate}`), "participant birth date not rendered");
  const scanned = withoutLestoDevTooling(html).toLowerCase();
  for (const forbidden of FORBIDDEN_APP_HTML) {
    ensure(
      step,
      !scanned.includes(forbidden.toLowerCase()),
      `signed-in /app HTML leaks forbidden substring "${forbidden}"`,
    );
  }
  const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
  ensure(
    step,
    sessionToken.length > 0 && !html.includes(sessionToken),
    "signed-in /app HTML leaks the session token value",
  );
}

async function verifySignedOutAppPage(base: string): Promise<void> {
  const step = "app-page-signed-out";
  const response = await fetch(`${base}/app`);
  ensure(step, response.status === 200, `GET /app (signed out) answered ${response.status}`);
  const html = await response.text();
  ensure(step, html.includes("Signed out"), "signed-out /app is missing its signed-out state");
  for (const name of REAL_NAMES) {
    ensure(step, !html.includes(name), `signed-out /app HTML exposes "${name}"`);
  }
}

async function runIosLiveCheck(port: number, scratchDir: string): Promise<void> {
  const step = "ios-live-round-trip";
  // localhost inside the simulator IS the host loopback, and http://localhost
  // is ATS-exempt — this reaches the same server the web legs just verified.
  const liveBase = `http://localhost:${port}`;
  const child = Bun.spawn({
    cmd: ["bash", join(ROOT, "scripts", "ios-live-test.sh")],
    cwd: ROOT,
    env: { ...process.env, SNACKDAY_LIVE_API: liveBase },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  await Bun.write(join(scratchDir, "xcodebuild.log"), output);
  const tail = output.split("\n").slice(-40).join("\n");
  ensure(step, exitCode === 0, `scripts/ios-live-test.sh exited ${exitCode}; log tail:\n${tail}`);
  ensure(
    step,
    /LIVE API|liveDevServerRoundTrip/u.test(output),
    `xcodebuild output never mentions the live test; log tail:\n${tail}`,
  );
  // A skipped live test would be a silent no-op acceptance: the verdict line
  // names the test, and its lowercase "skipped" cannot be confused with the
  // uppercase "SKIPPED" inside the test's own display name.
  ensure(
    step,
    !/(?:LIVE API|liveDevServerRoundTrip)[^\n]*skipped/u.test(output),
    `the live test was SKIPPED — SNACKDAY_LIVE_API never reached the test runner; log tail:\n${tail}`,
  );
  ensure(
    step,
    /(?:LIVE API|liveDevServerRoundTrip)[^\n]*passed|passed[^\n]*(?:LIVE API|liveDevServerRoundTrip)/u.test(
      output,
    ),
    `no pass verdict for the live test in the xcodebuild output; log tail:\n${tail}`,
  );
  ensure(
    step,
    output.includes("** TEST SUCCEEDED **"),
    `xcodebuild did not report TEST SUCCEEDED; log tail:\n${tail}`,
  );
}

async function dumpServerLogs(server: WebServer): Promise<void> {
  for (const path of [server.stdoutLog, server.stderrLog]) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.trim() === "") continue;
    console.error(`--- ${path} (tail) ---`);
    console.error(content.split("\n").slice(-25).join("\n"));
  }
}

async function main(): Promise<void> {
  const port = reserveEphemeralPort();
  const base = `http://127.0.0.1:${port}`;
  const scratchDir = await mkdtemp(join(tmpdir(), "snackday-accept-"));
  const server = bootWebServer(port, join(scratchDir, "acceptance.db"), scratchDir);
  try {
    await waitForReadiness(base, server);
    const cookie = await signIn(base);
    const ids = await createTeamSeasonAndRoster(base, cookie);
    await verifyTeamList(base, cookie, ids);
    await verifyRoster(base, cookie, ids);
    await verifySignedInAppPage(base, cookie);
    await verifySignedOutAppPage(base);
    await runIosLiveCheck(port, scratchDir);
  } catch (error) {
    await dumpServerLogs(server);
    throw error;
  } finally {
    await stopWebServer(server);
    await rm(scratchDir, { recursive: true, force: true });
  }
  console.log(
    `PASS acceptance on ${base}: dev sign-in, create team, create season, add child (birth date), ` +
      "attach two guardians (parent + caregiver), GET /api/teams, GET roster, " +
      "/app signed-in HTML (real names, no identifier leaks), /app signed-out HTML, iOS live round trip.",
  );
}

await main().catch((error: unknown) => {
  if (error instanceof StepFailure) {
    console.error(`FAIL [${error.step}] ${error.message}`);
  } else {
    console.error("FAIL [unexpected]", error);
  }
  process.exit(1);
});
