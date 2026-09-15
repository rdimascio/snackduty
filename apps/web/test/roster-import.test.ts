import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("./support/application").then((module) =>
  module.testApplication(),
);

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const sameOrigin = { "sec-fetch-site": "same-origin" };

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function createTeamAndSeason(cookie: string): Promise<{ teamId: string; seasonId: string }> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Import Tigers" },
  });
  expect(createdTeam.status).toBe(201);
  const teamId = (json(createdTeam) as { team: { id: string } }).team.id;

  const createdSeason = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(createdSeason.status).toBe(201);

  return { teamId, seasonId: (json(createdSeason) as { season: { id: string } }).season.id };
}

interface PreviewRowBody {
  line: number;
  verdict: string;
  duplicateOfLine?: number;
  issues?: { field: string; code: string }[];
  row?: { displayName: string; birthDate?: string; guardians: unknown[] };
}

interface PreviewBody {
  summary: {
    rows: number;
    valid: number;
    duplicateInFile: number;
    duplicateInRoster: number;
    invalid: number;
  };
  rows: PreviewRowBody[];
  ignoredColumns: number[];
}

function previewImport(cookie: string, teamId: string, seasonId: string, csv: string) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/roster/import/preview`, {
    headers: { ...sameOrigin, cookie },
    body: { csv },
  });
}

function commitImport(cookie: string, teamId: string, seasonId: string, rows: unknown[]) {
  return app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/roster/import`, {
    headers: { ...sameOrigin, cookie },
    body: { rows },
  });
}

function committableRows(preview: PreviewBody): unknown[] {
  return preview.rows.filter((row) => row.verdict === "valid").map((row) => row.row);
}

function readRoster(cookie: string, teamId: string, seasonId: string) {
  return app.handle("GET", `/api/teams/${teamId}/seasons/${seasonId}/roster`, {
    headers: { cookie },
  });
}

interface RosterEntryBody {
  participantId: string;
  displayName: string;
  birthDate?: string;
  guardians: { displayName: string; relationship: string }[];
  guardianInvitations: { pending: number; expired: number; accepted: number };
}

function rosterOf(response: { body: string }): RosterEntryBody[] {
  return (json(response) as { roster: RosterEntryBody[] }).roster;
}

const HEADER = "child_name,birth_date,guardian1_name,guardian1_relationship";
const TWO_CHILDREN = `${HEADER}\nCasey Kid,2018-04-09,Alex Guardian,parent\nRowan Child,2019-05-14,Sam Rivera,caregiver\n`;

async function reassignTeamToForeignAdult(teamId: string) {
  const now = new Date().toISOString();
  await config.db
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run(["person_other_adult", "Other Adult", now, now]);
  await config.db
    .prepare("UPDATE teams SET created_by_person_id = ? WHERE id = ?")
    .run(["person_other_adult", teamId]);
}

describe("roster import preview", () => {
  it("validates a file and writes nothing", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const response = await previewImport(cookie, teamId, seasonId, TWO_CHILDREN);
    expect(response.status).toBe(200);
    const preview = json(response) as PreviewBody;
    expect(preview.summary).toEqual({
      rows: 2,
      valid: 2,
      duplicateInFile: 0,
      duplicateInRoster: 0,
      invalid: 0,
    });
    expect(preview.rows[0]).toEqual({
      line: 2,
      verdict: "valid",
      row: {
        displayName: "Casey Kid",
        birthDate: "2018-04-09",
        guardians: [{ displayName: "Alex Guardian", relationship: "parent" }],
      },
    });
    expect(preview.rows[1]?.row?.displayName).toBe("Rowan Child");

    // PREVIEW WRITES NOTHING — the whole point of the two-step shape.
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
    expect(
      await config.db.prepare("SELECT id FROM people WHERE id NOT LIKE 'person_dev%'").all(),
    ).toEqual([]);
  });

  it("reads header aliases, extra columns, blank lines, and quoted values", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const csv =
      "Player Name,DOB,Jersey,Parent 1,Parent 1 Rel,GUARDIAN2NAME,guardian_2_relationship\r\n" +
      '"Kid, Casey",2018-04-09,7,Alex Guardian,PARENT,Bailey Guardian,caregiver\r\n' +
      "\r\n";

    const preview = json(await previewImport(cookie, teamId, seasonId, csv)) as PreviewBody;

    expect(preview.summary.rows).toBe(1);
    expect(preview.rows[0]?.row).toEqual({
      displayName: "Kid, Casey",
      birthDate: "2018-04-09",
      guardians: [
        { displayName: "Alex Guardian", relationship: "parent" },
        { displayName: "Bailey Guardian", relationship: "caregiver" },
      ],
    });
    // The `Jersey` column is column 3 and is simply not read.
    expect(preview.ignoredColumns).toEqual([3]);
  });

  it("flags a repeated child in the same file and one already on the roster", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const existing = await app.handle(
      "POST",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      {
        headers: { ...sameOrigin, cookie },
        body: { displayName: "Casey Kid", birthDate: "2018-04-09" },
      },
    );
    expect(existing.status).toBe(201);

    const csv =
      `${HEADER}\n` +
      "Rowan Child,2019-05-14,Sam Rivera,parent\n" +
      "  rowan   CHILD ,2019-05-14,Sam Rivera,parent\n" +
      "Casey Kid,2018-04-09,Alex Guardian,parent\n" +
      "Rowan Child,,Sam Rivera,parent\n";

    const preview = json(await previewImport(cookie, teamId, seasonId, csv)) as PreviewBody;

    expect(preview.summary).toEqual({
      rows: 4,
      valid: 2,
      duplicateInFile: 1,
      duplicateInRoster: 1,
      invalid: 0,
    });
    expect(preview.rows[0]?.verdict).toBe("valid");
    // Same child, spelled with different case and spacing.
    expect(preview.rows[1]).toMatchObject({
      line: 3,
      verdict: "duplicate_in_file",
      duplicateOfLine: 2,
    });
    expect(preview.rows[2]).toMatchObject({ line: 4, verdict: "duplicate_in_roster" });
    // A DIFFERENT birth date (here, none) is deliberately a different child —
    // the false-negative direction, which a manager can see and undo.
    expect(preview.rows[3]?.verdict).toBe("valid");
  });

  it("reports invalid rows with a field path and code, and no cell values", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const csv =
      `${HEADER}\n` +
      ",2018-04-09,Alex Guardian,parent\n" +
      "Rowan Child,05/14/2019,Sam Rivera,parent\n" +
      "Quinn Kid,2019-05-14,Sam Rivera,grandparent\n" +
      "Sky Kid,2019-05-14,,parent\n";

    const response = await previewImport(cookie, teamId, seasonId, csv);
    expect(response.status).toBe(200);
    const preview = json(response) as PreviewBody;

    expect(preview.summary).toMatchObject({ rows: 4, valid: 0, invalid: 4 });
    for (const row of preview.rows) {
      expect(row.verdict).toBe("invalid");
      // An invalid row NEVER carries its values back — only positions and codes.
      expect(row.row).toBeUndefined();
      expect(row.issues?.length).toBeGreaterThan(0);
    }
    expect(preview.rows[0]?.issues?.[0]?.field).toBe("displayName");
    expect(preview.rows[1]?.issues?.[0]?.field).toBe("birthDate");
    expect(preview.rows[2]?.issues?.[0]).toEqual({
      field: "guardians.0.relationship",
      code: "unknown_relationship",
    });
    expect(preview.rows[3]?.issues?.[0]).toEqual({
      field: "guardians.0.displayName",
      code: "required",
    });

    // PRIVACY: not a character of the file's content reaches the response.
    const serialized = response.body.toLowerCase();
    for (const forbidden of ["rowan", "quinn", "sky", "sam rivera", "05/14/2019", "grandparent"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("defaults a missing relationship label to the neutral one", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const preview = json(
      await previewImport(
        cookie,
        teamId,
        seasonId,
        "child_name,guardian1_name\nCasey Kid,Alex Guardian\n",
      ),
    ) as PreviewBody;

    expect(preview.rows[0]?.row?.guardians).toEqual([
      { displayName: "Alex Guardian", relationship: "guardian" },
    ]);
  });

  it("refuses a file that could carry a child's email address", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    for (const headerRow of [
      "child_name,email",
      "child_name,Child Email",
      "child_name,player e-mail",
      "child_name,EmailAddress",
      // `contact` reads as an adult's in most exports but is not a ROLE, so it
      // cannot be relied on to be one — refusal is the only safe answer.
      "child_name,contact_email",
    ]) {
      const response = await previewImport(
        cookie,
        teamId,
        seasonId,
        `${headerRow}\nCasey Kid,casey@example.test\n`,
      );
      expect(response.status).toBe(422);
      const rejection = json(response) as { code: string; column: number; error: string };
      expect(rejection.code).toBe("child_email_column");
      expect(rejection.column).toBe(2);
      // The position is named; the cell text never is.
      expect(response.body).not.toContain("casey@example.test");
      expect(response.body.toLowerCase()).not.toContain("casey kid");
    }

    // An ADULT-qualified address column is allowed to exist and is ignored —
    // Snackday stores no adult address yet, and a child's is never in doubt.
    const tolerated = await previewImport(
      cookie,
      teamId,
      seasonId,
      "child_name,guardian1_name,guardian1_email\nCasey Kid,Alex Guardian,alex@example.test\n",
    );
    expect(tolerated.status).toBe(200);
    expect((json(tolerated) as PreviewBody).ignoredColumns).toEqual([3]);

    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });

  it("refuses an unreadable file, a headerless one, and an oversized one", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const unreadable = await previewImport(
      cookie,
      teamId,
      seasonId,
      `${HEADER}\nCasey Kid,2018-04-09,"Alex Guardian,parent\n`,
    );
    expect(unreadable.status).toBe(422);
    expect(json(unreadable)).toMatchObject({ code: "csv_unterminated_quote", line: 2, column: 3 });

    const empty = await previewImport(cookie, teamId, seasonId, "\n\n");
    expect(empty.status).toBe(422);
    expect(json(empty)).toMatchObject({ code: "empty_file" });

    const noChildColumn = await previewImport(cookie, teamId, seasonId, "team,jersey\nTigers,7\n");
    expect(noChildColumn.status).toBe(422);
    expect(json(noChildColumn)).toMatchObject({ code: "missing_child_name_column" });
    expect((json(noChildColumn) as { expectedColumns: string[] }).expectedColumns.length).toBe(6);

    const huge = await previewImport(cookie, teamId, seasonId, "a".repeat(300_000));
    expect(huge.status).toBe(422);
    expect(json(huge)).toMatchObject({ code: "csv_too_large" });

    const manyRows = `${HEADER}\n${"Casey Kid,,Alex Guardian,parent\n".repeat(250)}`;
    const tooMany = await previewImport(cookie, teamId, seasonId, manyRows);
    expect(tooMany.status).toBe(422);
    expect(json(tooMany)).toMatchObject({ code: "too_many_rows" });

    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });
});

describe("roster import commit", () => {
  it("creates every previewed child with its guardians", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const preview = json(
      await previewImport(cookie, teamId, seasonId, TWO_CHILDREN),
    ) as PreviewBody;

    const response = await commitImport(cookie, teamId, seasonId, committableRows(preview));
    expect(response.status).toBe(201);
    const committed = json(response) as {
      summary: { requested: number; created: number; skipped: number };
      rows: { index: number; outcome: string; participant?: { displayName: string } }[];
    };
    expect(committed.summary).toEqual({ requested: 2, created: 2, skipped: 0 });
    expect(committed.rows.map((row) => row.outcome)).toEqual(["created", "created"]);

    const roster = rosterOf(await readRoster(cookie, teamId, seasonId));
    expect(roster.map((entry) => entry.displayName)).toEqual(["Casey Kid", "Rowan Child"]);
    expect(roster[0]?.guardians).toEqual([
      {
        guardianId: roster[0]?.guardians[0]?.guardianId,
        displayName: "Alex Guardian",
        relationship: "parent",
        permissions: ["participant.read", "participant.manage"],
        status: "active",
      },
    ]);
    expect(roster[1]?.birthDate).toBe("2019-05-14");

    // Person/Account separation survives a bulk write: two children and two
    // guardians are people, and not one of them has an Account.
    expect(await config.db.prepare("SELECT id FROM accounts").all()).toHaveLength(1);
    expect(
      await config.db
        .prepare("SELECT id FROM people WHERE id NOT IN (SELECT person_id FROM accounts)")
        .all(),
    ).toHaveLength(4);
  });

  it("is idempotent: a replayed commit creates one roster, not two", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const preview = json(
      await previewImport(cookie, teamId, seasonId, TWO_CHILDREN),
    ) as PreviewBody;
    const rows = committableRows(preview);

    const first = await commitImport(cookie, teamId, seasonId, rows);
    expect(first.status).toBe(201);

    // The SAME payload again — a double-tapped button, a retried request.
    const replay = await commitImport(cookie, teamId, seasonId, rows);
    expect(replay.status).toBe(200);
    expect(json(replay)).toMatchObject({ summary: { requested: 2, created: 0, skipped: 2 } });
    expect(
      (json(replay) as { rows: { outcome: string }[] }).rows.map((row) => row.outcome),
    ).toEqual(["duplicate_in_roster", "duplicate_in_roster"]);

    expect(await config.db.prepare("SELECT id FROM participants").all()).toHaveLength(2);
    expect(await config.db.prepare("SELECT id FROM guardian_relationships").all()).toHaveLength(2);
    expect(rosterOf(await readRoster(cookie, teamId, seasonId))).toHaveLength(2);
  });

  it("collapses a child repeated inside one commit payload", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    const row = {
      displayName: "Casey Kid",
      birthDate: "2018-04-09",
      guardians: [{ displayName: "Alex Guardian", relationship: "parent" }],
    };

    const response = await commitImport(cookie, teamId, seasonId, [row, row]);
    expect(response.status).toBe(201);
    expect(json(response)).toMatchObject({ summary: { requested: 2, created: 1, skipped: 1 } });
    expect(await config.db.prepare("SELECT id FROM participants").all()).toHaveLength(1);
  });

  it("attaches a guardian named twice in one row exactly once", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const response = await commitImport(cookie, teamId, seasonId, [
      {
        displayName: "Casey Kid",
        guardians: [
          { displayName: "Alex Guardian", relationship: "parent" },
          { displayName: "  alex   guardian ", relationship: "parent" },
          { displayName: "Alex Guardian", relationship: "caregiver" },
        ],
      },
    ]);
    expect(response.status).toBe(201);

    const roster = rosterOf(await readRoster(cookie, teamId, seasonId));
    // The duplicate-active-guardian invariant, shared with the single-add path:
    // same name + same relationship is one guardian; a different label is not.
    expect(roster[0]?.guardians.map((guardian) => guardian.relationship).toSorted()).toEqual([
      "caregiver",
      "parent",
    ]);
  });

  it("refuses invalid rows with positions and codes and writes nothing", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    const response = await commitImport(cookie, teamId, seasonId, [
      { displayName: "Casey Kid", guardians: [] },
      { displayName: "   ", guardians: [{ displayName: "Sam Rivera", relationship: "cousin" }] },
    ]);
    expect(response.status).toBe(422);
    const body = json(response) as {
      code: string;
      rows: { index: number; issues: { field: string }[] }[];
    };
    expect(body.code).toBe("invalid_rows");
    expect(body.rows[0]?.index).toBe(1);
    expect(body.rows[0]?.issues.map((issue) => issue.field).toSorted()).toEqual([
      "displayName",
      "guardians.0.relationship",
    ]);
    expect(response.body.toLowerCase()).not.toContain("sam rivera");
    expect(response.body.toLowerCase()).not.toContain("cousin");
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });
});

describe("roster import authorization boundaries", () => {
  it("requires authentication on both endpoints and writes nothing", async () => {
    const responses = [
      await app.handle("POST", "/api/teams/missing/seasons/missing/roster/import/preview", {
        headers: sameOrigin,
        body: { csv: TWO_CHILDREN },
      }),
      await app.handle("POST", "/api/teams/missing/seasons/missing/roster/import", {
        headers: sameOrigin,
        body: { rows: [{ displayName: "Casey Kid", guardians: [] }] },
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(json(response)).toEqual({ error: "authentication required" });
    }
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });

  it("hides a team the caller may not manage behind 404", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);
    await reassignTeamToForeignAdult(teamId);

    const responses = [
      await previewImport(cookie, teamId, seasonId, TWO_CHILDREN),
      await commitImport(cookie, teamId, seasonId, [{ displayName: "Casey Kid", guardians: [] }]),
      await previewImport(cookie, teamId, "season_missing", TWO_CHILDREN),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(json(response)).toEqual({ error: "team not found" });
    }
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });

  it("hides the endpoints from a read-only adult member of the team", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(ownerCookie);
    const memberCookie = await signIn("second-adult");
    const invited = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
      headers: { ...sameOrigin, cookie: ownerCookie },
      body: { invitedRole: "adult", inviteeLabel: "read-only adult" },
    });
    expect(invited.status).toBe(201);
    const inviteUrl =
      (json(invited) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
    const accepted = await app.handle("POST", "/api/invitations/accept", {
      headers: { ...sameOrigin, cookie: memberCookie },
      body: { token: inviteUrl.slice("/invite#".length) },
    });
    expect(accepted.status).toBe(200);

    // They can READ the roster ...
    expect((await readRoster(memberCookie, teamId, seasonId)).status).toBe(200);
    // ... and are hidden from the import, exactly like a stranger. Never a 403.
    const response = await previewImport(memberCookie, teamId, seasonId, TWO_CHILDREN);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "team not found" });
  });

  it("refuses cross-site and metadata-less requests before touching state", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    for (const headers of [{ "sec-fetch-site": "cross-site", cookie }, { cookie }]) {
      const responses = [
        await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/roster/import/preview`, {
          headers,
          body: { csv: TWO_CHILDREN },
        }),
        await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/roster/import`, {
          headers,
          body: { rows: [{ displayName: "Casey Kid", guardians: [] }] },
        }),
      ];
      for (const response of responses) expect(response.status).toBe(403);
    }
    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });

  it("rejects a malformed request body at the boundary", async () => {
    const cookie = await signIn();
    const { teamId, seasonId } = await createTeamAndSeason(cookie);

    await expect(
      app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/roster/import/preview`, {
        headers: { ...sameOrigin, cookie },
        body: { csv: 7 },
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });

    await expect(
      commitImport(
        cookie,
        teamId,
        seasonId,
        Array.from({ length: 201 }, () => ({})),
      ),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });

    expect(await config.db.prepare("SELECT id FROM participants").all()).toEqual([]);
  });
});
