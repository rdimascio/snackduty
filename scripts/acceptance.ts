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
 * it → drive the whole INVITATION journey (invite a second adult, preview the
 * link while signed out, accept, read the team back at the right access level,
 * resend, revoke) with the bearer token in the URL fragment throughout → drive
 * the EVENTS journey (a weekly practice series materialized across a real DST
 * boundary, per-occurrence cancellation that stays visible, guardian-scoped
 * attendance, and the child-free calendar feed with rotation, single-event ICS
 * export, and revocation). Finally it runs the env-gated iOS live round trip
 * (SnackdayDomainTests) against the SAME running server and refuses to accept
 * a skipped run.
 *
 * The server is torn down and the scratch database removed even on failure;
 * any assertion failure exits nonzero naming the failing step.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import { namedTestProblems, zeroTestProblems } from "./lib/xcodebuild-verdict";

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
// The bulk-entry half of the journey: one child a manager uploads rather than
// types, with a guardian in the same CSV row.
const IMPORTED_CHILD = { displayName: "Harper Acceptance", birthDate: "2018-11-02" } as const;
const IMPORTED_GUARDIAN = { displayName: "Robin Acceptance", relationship: "guardian" } as const;
const DEFAULT_GUARDIAN_PERMISSIONS = ["participant.read", "participant.manage"] as const;
const SECOND_ADULT_NAME = "Second Development Adult";
// The INVITER's own wording for the invitee — child-derived by design, which is
// exactly why the preview leg below proves it never reaches the invited parent.
// It is never printed: every assertion about it is phrased, not dumped.
const INVITEE_LABEL = `${CHILD.displayName.split(" ")[0] ?? ""}'s dad`;
const SECOND_INVITEE_LABEL = `${CHILD.displayName.split(" ")[0] ?? ""}'s aunt`;
// The invited parent may see the team, the inviter, and the role — the delivery
// payload's exact fields (docs: invite-delivery.ts). Anything else in a preview
// response is a leak: the child's name (and the label that quotes it), any
// internal id, and any credential-ish vocabulary.
const FORBIDDEN_PREVIEW = [
  CHILD.displayName.split(" ")[0] ?? "",
  "participant_",
  "person_",
  "invitation_",
  "team_",
  "token",
  "label",
] as const;
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

interface RosterEntry {
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
  guardianInvitations?: { pending?: number; expired?: number; accepted?: number };
}

async function readRoster(
  step: string,
  base: string,
  cookie: string,
  ids: JourneyIds,
): Promise<readonly RosterEntry[]> {
  const body = await requestJson(
    step,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/roster`,
    { headers: { Cookie: cookie } },
    200,
  );
  const roster = body["roster"] as readonly RosterEntry[];
  ensure(step, Array.isArray(roster), `roster read did not return a list: ${JSON.stringify(body)}`);
  return roster;
}

async function verifyRoster(base: string, cookie: string, ids: JourneyIds): Promise<void> {
  const step = "read-roster";
  const roster = await readRoster(step, base, cookie, ids);
  ensure(step, roster.length === 1, `expected one roster entry, got ${roster.length}`);
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
  ensure(
    step,
    JSON.stringify(child.guardianInvitations) ===
      JSON.stringify({ pending: 0, expired: 0, accepted: 0 }),
    `roster invitation counts should start at zero: ${JSON.stringify(child.guardianInvitations)}`,
  );
}

/**
 * The bulk half of roster entry, over real HTTP: PREVIEW the CSV (which writes
 * nothing and rules on every row), COMMIT what it returned, then COMMIT THE SAME
 * PAYLOAD AGAIN and prove the replay creates nothing. The file deliberately
 * carries all four verdicts a manager meets in practice — a new child, the same
 * child twice, a child already on the roster (the one the journey added by
 * hand), and a row with an unusable birth date.
 */
async function verifyRosterImport(base: string, cookie: string, ids: JourneyIds): Promise<void> {
  const step = "roster-import-preview";
  const csv =
    "child_name,birth_date,guardian1_name,guardian1_relationship\r\n" +
    `"${IMPORTED_CHILD.displayName}",${IMPORTED_CHILD.birthDate},${IMPORTED_GUARDIAN.displayName},${IMPORTED_GUARDIAN.relationship}\r\n` +
    `${IMPORTED_CHILD.displayName},${IMPORTED_CHILD.birthDate},${IMPORTED_GUARDIAN.displayName},${IMPORTED_GUARDIAN.relationship}\r\n` +
    `${CHILD.displayName},${CHILD.birthDate},${GUARDIAN_ONE.displayName},${GUARDIAN_ONE.relationship}\r\n` +
    "Malformed Acceptance,14/05/2019,Nobody Acceptance,parent\r\n";

  const previewed = await requestJson(
    step,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/roster/import/preview`,
    { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify({ csv }) },
    200,
  );
  const summary = previewed["summary"] as Record<string, number>;
  ensure(
    step,
    JSON.stringify(summary) ===
      JSON.stringify({
        rows: 4,
        valid: 1,
        duplicateInFile: 1,
        duplicateInRoster: 1,
        invalid: 1,
      }),
    `preview verdicts mismatch: ${JSON.stringify(summary)}`,
  );
  const previewRows = previewed["rows"] as readonly {
    verdict?: string;
    row?: { displayName?: string };
  }[];
  const committable = previewRows
    .filter((row) => row.verdict === "valid")
    .map((row) => row.row)
    .filter((row): row is { displayName?: string } => row !== undefined);
  ensure(step, committable.length === 1, "preview offered the wrong number of committable rows");
  // Preview WRITES NOTHING: the roster is still exactly what the manual legs built.
  const untouched = await readRoster(step, base, cookie, ids);
  ensure(step, untouched.length === 1, `preview changed the roster (${untouched.length} entries)`);

  const commitStep = "roster-import-commit";
  const commitBody = JSON.stringify({ rows: committable });
  const committed = await requestJson(
    commitStep,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/roster/import`,
    { method: "POST", headers: mutationHeaders(cookie), body: commitBody },
    201,
  );
  ensure(
    commitStep,
    JSON.stringify(committed["summary"]) ===
      JSON.stringify({ requested: 1, created: 1, skipped: 0 }),
    `commit summary mismatch: ${JSON.stringify(committed["summary"])}`,
  );

  const replayStep = "roster-import-replay";
  // The idempotence contract, made observable: the identical payload answers
  // 200 (not 201) and creates nothing, because every child it names is already
  // on the roster by the same identity rule the preview ruled on.
  const replayed = await requestJson(
    replayStep,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/roster/import`,
    { method: "POST", headers: mutationHeaders(cookie), body: commitBody },
    200,
  );
  ensure(
    replayStep,
    JSON.stringify(replayed["summary"]) ===
      JSON.stringify({ requested: 1, created: 0, skipped: 1 }),
    `replayed commit was not a no-op: ${JSON.stringify(replayed["summary"])}`,
  );

  const roster = await readRoster(replayStep, base, cookie, ids);
  ensure(
    replayStep,
    roster.length === 2,
    `expected two children after one import and one replay, got ${roster.length}`,
  );
  const imported = roster.find((entry) => entry.displayName === IMPORTED_CHILD.displayName);
  ensure(
    replayStep,
    imported?.birthDate === IMPORTED_CHILD.birthDate &&
      imported.guardians?.length === 1 &&
      imported.guardians[0]?.displayName === IMPORTED_GUARDIAN.displayName &&
      imported.guardians[0].relationship === IMPORTED_GUARDIAN.relationship,
    `imported child mismatch: ${JSON.stringify(imported)}`,
  );
}

/** After a guardian invitation names a child, the roster reports it — counts only. */
async function verifyRosterInvitationStatus(
  base: string,
  cookie: string,
  ids: JourneyIds,
): Promise<void> {
  const step = "roster-invitation-status";
  const roster = await readRoster(step, base, cookie, ids);
  const child = roster.find((entry) => entry.participantId === ids.participantId);
  ensure(
    step,
    JSON.stringify(child?.guardianInvitations) ===
      JSON.stringify({ pending: 1, expired: 0, accepted: 0 }),
    `roster does not report the pending guardian invitation: ${JSON.stringify(child?.guardianInvitations)}`,
  );
  const serialized = JSON.stringify(roster).toLowerCase();
  for (const forbidden of [INVITEE_LABEL.toLowerCase(), "invitee", "token", "invite#"]) {
    ensure(step, !serialized.includes(forbidden), `roster leaks "${forbidden}"`);
  }
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

/**
 * The token out of a delivered invitation link, with the LINK-SHAPE RULE
 * asserted on the way through: a bearer credential may never appear in the
 * request line (path or query) of a Snackday URL, so the whole of `/invite` is
 * what a server ever receives and the token rides the fragment. Nothing here
 * ever prints the token.
 */
function tokenOf(step: string, inviteUrl: string): string {
  const [requestLine, ...fragment] = inviteUrl.split("#");
  ensure(
    step,
    requestLine === "/invite" && fragment.length === 1,
    "invite link must be exactly `/invite#<token>`: a bearer credential may never appear in a request line",
  );
  const token = fragment[0] ?? "";
  ensure(step, /^[0-9a-f]{64}$/u.test(token), "invite link fragment is not a 64-hex token");
  return token;
}

interface PendingInvitation {
  readonly invitationId: string;
  readonly token: string;
}

async function createInvitation(
  base: string,
  cookie: string,
  teamId: string,
  label: string,
  participantId?: string,
): Promise<PendingInvitation> {
  const step = "create-invitation";
  const body = await requestJson(
    step,
    `${base}/api/teams/${teamId}/invitations`,
    {
      method: "POST",
      headers: mutationHeaders(cookie),
      body: JSON.stringify({
        invitedRole: "adult",
        inviteeLabel: label,
        ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
      }),
    },
    201,
  );
  const invitation = body["invitation"] as { id?: string; status?: string; inviteUrl?: string };
  ensure(step, typeof invitation?.id === "string", "created invitation carries no id");
  ensure(
    step,
    invitation.status === "pending",
    `new invitation is not pending: ${String(invitation.status)}`,
  );
  ensure(step, typeof invitation.inviteUrl === "string", "created invitation carries no link");

  return { invitationId: invitation.id, token: tokenOf(step, invitation.inviteUrl) };
}

/** `POST /api/invitations/preview` — the token in a BODY, never a request line. */
function previewInvitation(base: string, token: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/api/invitations/preview`, {
    method: "POST",
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ token }),
  });
}

/** The one hiding answer, as bytes — every invalid reason must equal this. */
async function hiddenPreviewBody(base: string): Promise<string> {
  const step = "preview-hiding";
  const response = await previewInvitation(base, "not-a-real-token");
  ensure(
    step,
    response.status === 404,
    `preview of an unknown token answered ${response.status} (expected 404)`,
  );
  return await response.text();
}

async function verifyPendingInvitationListed(
  base: string,
  cookie: string,
  teamId: string,
  pending: PendingInvitation,
): Promise<void> {
  const step = "list-invitations";
  const body = await requestJson(
    step,
    `${base}/api/teams/${teamId}/invitations`,
    { headers: { Cookie: cookie } },
    200,
  );
  const invitations = body["invitations"] as readonly {
    id?: string;
    status?: string;
    inviteUrl?: string;
  }[];
  ensure(step, Array.isArray(invitations), "invitation list is not an array");
  const listed = invitations.find((entry) => entry.id === pending.invitationId);
  ensure(step, listed !== undefined, "the created invitation is missing from the owner's list");
  ensure(
    step,
    listed.status === "pending",
    `listed invitation is not pending: ${String(listed.status)}`,
  );
  ensure(
    step,
    typeof listed.inviteUrl === "string",
    "a pending invitation is listed without its link",
  );
  ensure(
    step,
    tokenOf(step, listed.inviteUrl) === pending.token,
    "the listed link does not carry the token the create response delivered",
  );
}

/**
 * The invited parent's view, resolved the way the landing page resolves it: the
 * token from the fragment, POSTed in a body, while SIGNED OUT (which is the
 * invited parent's actual situation).
 */
async function verifySignedOutPreview(base: string, token: string): Promise<void> {
  const step = "preview-invitation";
  const response = await previewInvitation(base, token);
  const text = await response.text();
  ensure(step, response.status === 200, `preview answered ${response.status} (expected 200)`);
  const preview = JSON.parse(text) as Record<string, unknown>;
  ensure(
    step,
    preview["state"] === "preview" &&
      preview["teamName"] === TEAM_NAME &&
      preview["inviterDisplayName"] === "Development Adult" &&
      preview["invitedRole"] === "adult",
    "preview does not name the team, the inviter, and the invited role",
  );
  // The privacy contract as an EXACT key set — no room for a field to creep in.
  ensure(
    step,
    JSON.stringify(Object.keys(preview).toSorted()) ===
      JSON.stringify(["invitedRole", "inviterDisplayName", "state", "teamName"]),
    `preview payload has unexpected fields: ${JSON.stringify(Object.keys(preview).toSorted())}`,
  );
  const scanned = text.toLowerCase();
  for (const forbidden of FORBIDDEN_PREVIEW) {
    ensure(
      step,
      !scanned.includes(forbidden.toLowerCase()),
      `preview response leaks forbidden substring "${forbidden}"`,
    );
  }
}

/** Accepting the invitation, and what the new member can see afterwards. */
async function verifyAcceptAndMembership(
  base: string,
  memberCookie: string,
  token: string,
  teamId: string,
): Promise<void> {
  const step = "accept-invitation";
  const body = await requestJson(
    step,
    `${base}/api/invitations/accept`,
    { method: "POST", headers: mutationHeaders(memberCookie), body: JSON.stringify({ token }) },
    200,
  );
  const membership = body["membership"] as { role?: string };
  const team = body["team"] as { id?: string; name?: string };
  ensure(step, membership?.role === "adult", `granted role mismatch: ${String(membership?.role)}`);
  ensure(step, team?.id === teamId && team.name === TEAM_NAME, "accept named the wrong team");

  const listStep = "member-team-list";
  const listed = await requestJson(
    listStep,
    `${base}/api/teams`,
    { headers: { Cookie: memberCookie } },
    200,
  );
  const teams = listed["teams"] as readonly {
    team?: { id?: string; name?: string };
    access?: string;
  }[];
  ensure(
    listStep,
    Array.isArray(teams) && teams.length === 1 && teams[0]?.team?.id === teamId,
    "the accepting adult does not see exactly the team they joined",
  );
  // The access level the member reads must be the one their GRANTED role means:
  // `adult` reads, `owner` manages (lib/server/teams.ts owns that rule).
  ensure(
    listStep,
    teams[0].access === (membership.role === "owner" ? "manage" : "read"),
    `access level "${String(teams[0].access)}" does not match granted role "${String(membership.role)}"`,
  );
}

/**
 * The accepted token stays calm for the adult who used it — and stays hidden
 * from everyone else, including the inviter.
 */
async function verifyAcceptedPreview(
  base: string,
  memberCookie: string,
  ownerCookie: string,
  token: string,
  hidden: string,
): Promise<void> {
  const step = "preview-accepted";
  const mine = await previewInvitation(base, token, memberCookie);
  const text = await mine.text();
  ensure(step, mine.status === 200, `accepted preview answered ${mine.status} (expected 200)`);
  const accepted = JSON.parse(text) as Record<string, unknown>;
  ensure(
    step,
    accepted["state"] === "accepted" &&
      accepted["teamName"] === TEAM_NAME &&
      accepted["grantedRole"] === "adult",
    "the accepted state does not name the team and the role in force",
  );
  const scanned = text.toLowerCase();
  for (const forbidden of FORBIDDEN_PREVIEW) {
    ensure(
      step,
      !scanned.includes(forbidden.toLowerCase()),
      `accepted preview leaks forbidden substring "${forbidden}"`,
    );
  }

  for (const cookie of [ownerCookie, undefined]) {
    const other = await previewInvitation(base, token, cookie);
    ensure(step, other.status === 404, `a used token answered ${other.status} to another visitor`);
    ensure(
      step,
      (await other.text()) === hidden,
      "a used token is distinguishable from an unknown one",
    );
  }
}

/** Resend rotates the token (the old link dies); revoke kills the new one. */
async function verifyResendAndRevoke(
  base: string,
  ownerCookie: string,
  teamId: string,
  hidden: string,
): Promise<void> {
  const step = "resend-invitation";
  const first = await createInvitation(base, ownerCookie, teamId, SECOND_INVITEE_LABEL);
  const resent = await requestJson(
    step,
    `${base}/api/teams/${teamId}/invitations/${first.invitationId}/resend`,
    { method: "POST", headers: mutationHeaders(ownerCookie) },
    200,
  );
  const rotatedUrl = (resent["invitation"] as { inviteUrl?: string }).inviteUrl ?? "";
  const rotated = tokenOf(step, rotatedUrl);
  ensure(step, rotated !== first.token, "resend did not rotate the token");

  const dead = await previewInvitation(base, first.token);
  ensure(step, dead.status === 404, `the resent-over token answered ${dead.status}`);
  ensure(step, (await dead.text()) === hidden, "a rotated-away token is distinguishable");

  const live = await previewInvitation(base, rotated);
  ensure(step, live.status === 200, `the rotated token answered ${live.status} (expected 200)`);
  await live.text();

  const revokeStep = "revoke-invitation";
  const revoked = await requestJson(
    revokeStep,
    `${base}/api/teams/${teamId}/invitations/${first.invitationId}/revoke`,
    { method: "POST", headers: mutationHeaders(ownerCookie) },
    200,
  );
  ensure(
    revokeStep,
    (revoked["invitation"] as { status?: string }).status === "revoked",
    "revoke did not move the invitation to revoked",
  );
  const afterRevoke = await previewInvitation(base, rotated);
  ensure(
    revokeStep,
    afterRevoke.status === 404,
    `a revoked token answered ${afterRevoke.status} (expected 404)`,
  );
  ensure(
    revokeStep,
    (await afterRevoke.text()) === hidden,
    "a revoked token is distinguishable from an unknown one",
  );
}

async function signInAsSecondAdult(base: string): Promise<string> {
  const step = "second-adult-sign-in";
  const response = await fetch(`${base}/api/dev/sign-in`, {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({ persona: "second-adult" }),
  });
  ensure(
    step,
    response.status === 200,
    `POST /api/dev/sign-in (second-adult) answered ${response.status}`,
  );
  const setCookie = response.headers.get("set-cookie");
  ensure(
    step,
    setCookie !== null && setCookie.startsWith("snackday_session_dev="),
    "the second adult sign-in issued no session cookie",
  );
  const cookie = setCookie.split(";", 1)[0];
  ensure(step, cookie !== undefined && cookie.length > 0, "second adult session cookie is empty");
  const identity = (await response.json()) as { person?: { displayName?: string } };
  ensure(
    step,
    identity.person?.displayName === SECOND_ADULT_NAME,
    `second-adult identity mismatch: ${JSON.stringify(identity)}`,
  );
  return cookie;
}

/**
 * The invitation journey, end to end and over real HTTP: an owner invites a
 * second adult (binding them to the child as a guardian), the invited parent
 * previews the link SIGNED OUT, signs in, accepts, and reads the team back —
 * then resend rotates the link and revoke kills it. The credential is in the
 * fragment throughout, so every server-visible request line is just `/invite`
 * or an API path, and nothing here prints the token or the invitee label.
 */
async function verifyInvitationJourney(
  base: string,
  ownerCookie: string,
  ids: JourneyIds,
): Promise<void> {
  const hidden = await hiddenPreviewBody(base);
  const pending = await createInvitation(
    base,
    ownerCookie,
    ids.teamId,
    INVITEE_LABEL,
    ids.participantId,
  );
  await verifyPendingInvitationListed(base, ownerCookie, ids.teamId, pending);
  await verifyRosterInvitationStatus(base, ownerCookie, ids);
  await verifySignedOutPreview(base, pending.token);

  const memberCookie = await signInAsSecondAdult(base);
  await verifyAcceptAndMembership(base, memberCookie, pending.token, ids.teamId);
  await verifyAcceptedPreview(base, memberCookie, ownerCookie, pending.token, hidden);
  await verifyResendAndRevoke(base, ownerCookie, ids.teamId, hidden);
}

// The events leg: a weekly practice whose range CROSSES the 2026-03-08
// America/Los_Angeles spring-forward, so wall-time correctness is observable
// as two different UTC instants for the same 17:00.
const EVENT_SERIES = {
  title: "Tuesday Practice",
  kind: "practice",
  location: "Riverside Park, Field 2",
  notes: "Bring water and shin guards",
  schedule: {
    timeZone: "America/Los_Angeles",
    localTime: "17:00",
    durationMinutes: 60,
    frequency: "weekly",
    byWeekday: ["tuesday"],
    startDate: "2026-03-03",
    untilDate: "2026-03-17",
  },
} as const;
const EXPECTED_EVENT_INSTANTS = [
  "2026-03-04T01:00:00.000Z",
  "2026-03-11T00:00:00.000Z",
  "2026-03-18T00:00:00.000Z",
] as const;
const CANCEL_REASON = "Field flooded";
// Names and vocabulary that must NEVER appear in a pollable calendar feed: a
// leaked feed URL exposes a practice schedule, not a roster of minors.
const FORBIDDEN_FEED = [
  CHILD.displayName.split(" ")[0] ?? "",
  IMPORTED_CHILD.displayName.split(" ")[0] ?? "",
  GUARDIAN_ONE.displayName.split(" ")[0] ?? "",
  CHILD.birthDate,
  "participant",
  "guardian",
  "attendance",
  "person_",
] as const;

interface EventOccurrenceView {
  id?: string;
  localDate?: string;
  startsAt?: string;
  status?: string;
  cancelledReason?: string;
}

async function createEventSeries(
  base: string,
  cookie: string,
  ids: JourneyIds,
): Promise<readonly string[]> {
  const step = "create-event-series";
  const created = await requestJson(
    step,
    `${base}/api/teams/${ids.teamId}/seasons/${ids.seasonId}/events`,
    { method: "POST", headers: mutationHeaders(cookie), body: JSON.stringify(EVENT_SERIES) },
    201,
  );
  const occurrences = created["occurrences"] as readonly EventOccurrenceView[];
  ensure(
    step,
    Array.isArray(occurrences) && occurrences.length === 3,
    `expected three materialized occurrences: ${JSON.stringify(created)}`,
  );
  // Timezone correctness, observable: 17:00 PST is 01:00Z, 17:00 PDT is
  // 00:00Z — one series, one wall time, DST-correct instants either side.
  ensure(
    step,
    JSON.stringify(occurrences.map((occurrence) => occurrence.startsAt)) ===
      JSON.stringify(EXPECTED_EVENT_INSTANTS),
    `occurrence instants are not wall-time-correct: ${JSON.stringify(occurrences)}`,
  );
  const occurrenceIds = occurrences.map((occurrence) => occurrence.id ?? "");
  ensure(
    step,
    occurrenceIds.every((id) => id.startsWith("event_occurrence_")),
    "occurrence ids missing",
  );
  return occurrenceIds;
}

async function verifyCancelOccurrence(
  base: string,
  cookie: string,
  teamId: string,
  occurrenceId: string,
): Promise<void> {
  const step = "cancel-occurrence";
  const cancelled = await requestJson(
    step,
    `${base}/api/teams/${teamId}/occurrences/${occurrenceId}/cancel`,
    {
      method: "POST",
      headers: mutationHeaders(cookie),
      body: JSON.stringify({ reason: CANCEL_REASON }),
    },
    200,
  );
  const occurrence = cancelled["occurrence"] as EventOccurrenceView;
  ensure(
    step,
    occurrence?.status === "cancelled" && occurrence.cancelledReason === CANCEL_REASON,
    `cancellation state mismatch: ${JSON.stringify(cancelled)}`,
  );

  // Cancellation is a STATE, not a delete: the team events list still carries
  // the occurrence, visibly cancelled, with its reason.
  const listed = await requestJson(
    step,
    `${base}/api/teams/${teamId}/events`,
    { headers: { Cookie: cookie } },
    200,
  );
  const events = listed["events"] as readonly { occurrences?: readonly EventOccurrenceView[] }[];
  const all = events.flatMap((entry) => entry.occurrences ?? []);
  ensure(step, all.length === 3, `cancelled occurrence disappeared from the list: ${all.length}`);
  const stillThere = all.find((occurrence) => occurrence.id === occurrenceId);
  ensure(
    step,
    stillThere?.status === "cancelled" && stillThere.cancelledReason === CANCEL_REASON,
    "the cancelled occurrence is not listed with its reason",
  );
}

async function recordAttendance(
  base: string,
  cookie: string,
  teamId: string,
  occurrenceId: string,
  participantId: string,
  status: string,
): Promise<Response> {
  return fetch(`${base}/api/teams/${teamId}/occurrences/${occurrenceId}/attendance`, {
    method: "POST",
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ participantId, status }),
  });
}

/**
 * Attendance under the guardian rule, over real HTTP: the second adult (who
 * accepted the invitation naming the child, so they hold a REAL guardian edge)
 * answers for their own child; the manager answers for anyone; the guardian's
 * reach into another family's child is the same hiding 404 an unknown child
 * gets — byte-identical, never a 403.
 */
async function verifyAttendance(
  base: string,
  ownerCookie: string,
  guardianCookie: string,
  ids: JourneyIds,
  occurrenceId: string,
): Promise<void> {
  const step = "record-attendance";
  const own = await recordAttendance(
    base,
    guardianCookie,
    ids.teamId,
    occurrenceId,
    ids.participantId,
    "yes",
  );
  ensure(step, own.status === 200, `guardian RSVP for own child answered ${own.status}`);

  const roster = await readRoster(step, base, ownerCookie, ids);
  const importedChild = roster.find((entry) => entry.displayName === IMPORTED_CHILD.displayName);
  const importedId = importedChild?.participantId;
  ensure(step, typeof importedId === "string", "imported child missing from roster");

  const asManager = await recordAttendance(
    base,
    ownerCookie,
    ids.teamId,
    occurrenceId,
    importedId,
    "maybe",
  );
  ensure(step, asManager.status === 200, `manager attendance answered ${asManager.status}`);

  const foreign = await recordAttendance(
    base,
    guardianCookie,
    ids.teamId,
    occurrenceId,
    importedId,
    "yes",
  );
  const unknown = await recordAttendance(
    base,
    guardianCookie,
    ids.teamId,
    occurrenceId,
    "participant_missing",
    "yes",
  );
  ensure(
    step,
    foreign.status === 404 && unknown.status === 404,
    `guardian reach beyond their child answered ${foreign.status}/${unknown.status} (expected 404s)`,
  );
  ensure(
    step,
    (await foreign.text()) === (await unknown.text()),
    "another family's child is distinguishable from an unknown child",
  );

  const readStep = "read-attendance";
  const asGuardian = await requestJson(
    readStep,
    `${base}/api/teams/${ids.teamId}/occurrences/${occurrenceId}/attendance`,
    { headers: { Cookie: guardianCookie } },
    200,
  );
  const guardianView = asGuardian["attendance"] as {
    counts?: Record<string, number>;
    entries?: readonly { participantId?: string; status?: string }[];
  };
  ensure(
    readStep,
    JSON.stringify(guardianView.counts) === JSON.stringify({ yes: 1, no: 0, maybe: 1 }),
    `attendance counts mismatch: ${JSON.stringify(guardianView.counts)}`,
  );
  // The guardian sees THEIR child's entry and only that; the other child is a
  // number in the counts, not a name.
  ensure(
    readStep,
    guardianView.entries?.length === 1 &&
      guardianView.entries[0]?.participantId === ids.participantId &&
      guardianView.entries[0].status === "yes",
    `guardian attendance view is not scoped to their own child: ${JSON.stringify(guardianView.entries)}`,
  );

  const asOwner = await requestJson(
    readStep,
    `${base}/api/teams/${ids.teamId}/occurrences/${occurrenceId}/attendance`,
    { headers: { Cookie: ownerCookie } },
    200,
  );
  const ownerView = asOwner["attendance"] as { entries?: readonly unknown[] };
  ensure(
    readStep,
    ownerView.entries?.length === 2,
    `manager attendance view should carry both children: ${JSON.stringify(ownerView.entries)}`,
  );
}

/**
 * The calendar feed: minted per adult, polled with NO session exactly like
 * Apple/Google will, child-free by construction, rotated by re-minting, and
 * exported per event as an authenticated download.
 */
async function verifyCalendarFeed(
  base: string,
  ownerCookie: string,
  ids: JourneyIds,
  cancelledOccurrenceId: string,
): Promise<void> {
  const step = "mint-calendar-feed";
  const minted = await requestJson(
    step,
    `${base}/api/teams/${ids.teamId}/calendar-feed`,
    { method: "POST", headers: mutationHeaders(ownerCookie) },
    201,
  );
  const feedUrl = (minted["feed"] as { url?: string }).url ?? "";
  ensure(
    step,
    /^\/calendar\/feed\/[0-9a-f]{64}$/u.test(feedUrl),
    "feed URL is not the random-token shape",
  );
  ensure(step, !feedUrl.includes(ids.teamId), "feed URL derives from the team id");

  const feedStep = "poll-calendar-feed";
  // A calendar client's poll: plain GET, no cookie, no fetch metadata.
  const polled = await fetch(`${base}${feedUrl}`);
  ensure(step, polled.status === 200, `feed poll answered ${polled.status}`);
  ensure(
    feedStep,
    (polled.headers.get("content-type") ?? "") === "text/calendar; charset=utf-8",
    `feed content type: ${String(polled.headers.get("content-type"))}`,
  );
  ensure(
    feedStep,
    (polled.headers.get("x-robots-tag") ?? "").includes("noindex"),
    "feed response is not noindex",
  );
  const body = await polled.text();
  ensure(
    feedStep,
    body.includes(`X-WR-CALNAME:${TEAM_NAME} (Snackday)`),
    "feed lacks the calendar name",
  );
  ensure(feedStep, body.includes(`SUMMARY:${EVENT_SERIES.title}`), "feed lacks the event title");
  ensure(
    feedStep,
    body.includes("DTSTART:20260304T010000Z") && body.includes("DTSTART:20260311T000000Z"),
    "feed instants are not DST-correct",
  );
  ensure(
    feedStep,
    (body.match(/STATUS:CANCELLED/gu) ?? []).length === 1 && !body.includes(CANCEL_REASON),
    "the cancelled occurrence is not represented as exactly one STATUS:CANCELLED without its reason",
  );
  const scanned = body.toLowerCase();
  for (const forbidden of FORBIDDEN_FEED) {
    ensure(feedStep, !scanned.includes(forbidden.toLowerCase()), `feed leaks "${forbidden}"`);
  }

  const rotateStep = "rotate-calendar-feed";
  const rotated = await requestJson(
    rotateStep,
    `${base}/api/teams/${ids.teamId}/calendar-feed`,
    { method: "POST", headers: mutationHeaders(ownerCookie) },
    200,
  );
  const rotatedUrl = (rotated["feed"] as { url?: string }).url ?? "";
  ensure(rotateStep, rotatedUrl !== feedUrl, "re-minting did not rotate the feed URL");
  const dead = await fetch(`${base}${feedUrl}`);
  const bogus = await fetch(`${base}/calendar/feed/${"0".repeat(64)}`);
  ensure(rotateStep, dead.status === 404, `the rotated-away feed answered ${dead.status}`);
  ensure(
    rotateStep,
    (await dead.text()) === (await bogus.text()),
    "a rotated-away feed is distinguishable from an unknown one",
  );
  ensure(
    rotateStep,
    (await fetch(`${base}${rotatedUrl}`)).status === 200,
    "the rotated feed does not serve",
  );

  const exportStep = "export-occurrence-ics";
  const exported = await fetch(
    `${base}/api/teams/${ids.teamId}/occurrences/${cancelledOccurrenceId}/export`,
    { headers: { Cookie: ownerCookie } },
  );
  ensure(exportStep, exported.status === 200, `ICS export answered ${exported.status}`);
  ensure(
    exportStep,
    (exported.headers.get("content-disposition") ?? "").includes("attachment"),
    "ICS export is not an attachment download",
  );
  const exportBody = await exported.text();
  ensure(
    exportStep,
    (exportBody.match(/BEGIN:VEVENT/gu) ?? []).length === 1 &&
      exportBody.includes("STATUS:CANCELLED"),
    "single-event export does not carry exactly the cancelled event",
  );
  const signedOutExport = await fetch(
    `${base}/api/teams/${ids.teamId}/occurrences/${cancelledOccurrenceId}/export`,
  );
  ensure(exportStep, signedOutExport.status === 401, "ICS export is reachable signed out");

  const revokeStep = "revoke-calendar-feed";
  await requestJson(
    revokeStep,
    `${base}/api/teams/${ids.teamId}/calendar-feed/revoke`,
    { method: "POST", headers: mutationHeaders(ownerCookie) },
    200,
  );
  const afterRevoke = await fetch(`${base}${rotatedUrl}`);
  ensure(revokeStep, afterRevoke.status === 404, `a revoked feed answered ${afterRevoke.status}`);
  const freshUnknown = await fetch(`${base}/calendar/feed/${"f".repeat(64)}`);
  ensure(
    revokeStep,
    (await afterRevoke.text()) === (await freshUnknown.text()),
    "a revoked feed is distinguishable from an unknown one",
  );
}

/**
 * The events journey: the manager creates the DST-crossing weekly practice,
 * cancels one occurrence with a reason, both adults record attendance under
 * the guardian rule, and the schedule leaves the building only through the
 * child-free calendar feed and the authenticated ICS export.
 */
async function verifyEventsJourney(
  base: string,
  ownerCookie: string,
  ids: JourneyIds,
): Promise<void> {
  const occurrenceIds = await createEventSeries(base, ownerCookie, ids);
  const cancelTarget = occurrenceIds[1] ?? "";
  await verifyCancelOccurrence(base, ownerCookie, ids.teamId, cancelTarget);

  // A fresh session for the second adult — already a member AND the child's
  // guardian from the invitation journey above.
  const guardianCookie = await signInAsSecondAdult(base);
  await verifyAttendance(base, ownerCookie, guardianCookie, ids, occurrenceIds[0] ?? "");
  await verifyCalendarFeed(base, ownerCookie, ids, cancelTarget);
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
  // Both iOS entry points share ONE verdict guard (scripts/lib/xcodebuild-verdict.ts):
  // a zero-match run prints the success banner and exits 0, so neither signal is
  // evidence on its own. `zeroTestProblems` covers the generic trap; the named
  // check covers the one test THIS leg exists to run.
  const problems = [
    ...zeroTestProblems(exitCode, output),
    ...namedTestProblems(output, "the live round-trip test", "LIVE API|liveDevServerRoundTrip"),
  ];
  ensure(step, problems.length === 0, `${problems.join("; ")}; log tail:\n${tail}`);
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
    await verifyRosterImport(base, cookie, ids);
    await verifyInvitationJourney(base, cookie, ids);
    await verifyEventsJourney(base, cookie, ids);
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
      "/app signed-in HTML (real names, no identifier leaks), /app signed-out HTML, " +
      "roster CSV import (preview writes nothing and rules on all four verdicts, commit creates " +
      "one child with a guardian, replayed commit creates nothing), " +
      "invitation journey (create, list pending with link, roster reports the pending invitation " +
      "as counts only, signed-out preview by POSTed fragment " +
      "token with no label/child/id leaks, second-adult sign-in, accept, member team list with " +
      "matching access level, accepted preview hidden from everyone else, resend rotates, revoke), " +
      "events journey (weekly series materialized with DST-correct instants, cancellation stays " +
      "visible with its reason, guardian-scoped attendance with hiding 404s, child-free calendar " +
      "feed polled unauthenticated with noindex, re-mint rotates the feed URL, authenticated " +
      "single-event ICS export, revoke), " +
      "iOS live round trip.",
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
