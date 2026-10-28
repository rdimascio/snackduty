import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  CHILDREN,
  COMETS,
  FALCONS,
  button,
  cardPath,
  dateSpellings,
  expectHtmlLacks,
  expectNoButton,
  localDatePlus,
  main,
  mainText,
  openFresh,
  seededBirthDates,
  waitForStatus,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import type { Scenario } from "./support/scenario";
import { asRole, refused } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(90_000);

const ROSTER_PAGE = `/app/roster?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`;
const COMETS_ROSTER_PAGE = `/app/roster?team=${COMETS.teamId}&season=${COMETS.seasonId}`;
const SEASON_API = `/api/teams/${FALCONS.teamId}/seasons/${FALCONS.seasonId}`;
const FALCONS_CHILDREN = [CHILDREN.avery, CHILDREN.blake, CHILDREN.casey] as const;

interface RosterApiEntry {
  readonly participantId: string;
  readonly birthDate?: string;
  readonly guardians: readonly { readonly displayName: string }[];
  readonly guardianInvitations?: unknown;
}

function skillEventsPath(participantId: string): string {
  return `/api/dev/teams/${FALCONS.teamId}/participants/${participantId}/skill-events`;
}

function rosterNames(scenario: Scenario): string[] {
  return scenario
    .query<{ display_name: string }>(
      "SELECT people.display_name FROM memberships JOIN participants ON participants.id = memberships.member_participant_id JOIN people ON people.id = participants.person_id WHERE memberships.team_id = ? AND memberships.season_id = ? AND memberships.status = 'active' ORDER BY people.display_name",
      FALCONS.teamId,
      FALCONS.seasonId,
    )
    .map((row) => row.display_name);
}

function guardianNames(scenario: Scenario, participantId: string): string[] {
  return scenario
    .query<{ display_name: string; relationship: string }>(
      "SELECT people.display_name, guardian_relationships.relationship FROM guardian_relationships JOIN people ON people.id = guardian_relationships.guardian_person_id WHERE guardian_relationships.participant_id = ? AND guardian_relationships.status = 'active' ORDER BY people.display_name",
      participantId,
    )
    .map((row) => `${row.display_name} (${row.relationship})`);
}

function seededAge(scenario: Scenario, participantId: string): number {
  const [row] = scenario.query<{ birth_date: string }>(
    "SELECT birth_date FROM participants WHERE id = ?",
    participantId,
  );
  if (row === undefined) throw new Error(`no birth date for ${participantId}`);
  const [bornYear, bornMonth, bornDay] = row.birth_date.split("-").map(Number);
  const [year, month, day] = localDatePlus(0).split("-").map(Number);
  const hadBirthday =
    (month ?? 0) > (bornMonth ?? 0) || (month === bornMonth && (day ?? 0) >= (bornDay ?? 0));
  return (year ?? 0) - (bornYear ?? 0) - (hadBirthday ? 0 : 1);
}

function skillEventCount(scenario: Scenario, participantId: string): number {
  return scenario.query("SELECT 1 FROM skill_events WHERE participant_id = ?", participantId)
    .length;
}

async function rosterCard(session: RoleSession, name: string) {
  return main(session.page)
    .getByRole("list", { name: "Players" })
    .getByRole("listitem")
    .filter({ has: session.page.getByText(name, { exact: true }) });
}

async function addPlayer(scenario: Scenario, session: RoleSession, name: string): Promise<void> {
  await openFresh(session, ROSTER_PAGE);
  const form = main(session.page).getByRole("form", { name: "Add a player" });
  await form.getByLabel("Player name").fill(name);
  await form.getByLabel(/Birth date/u).fill("2018-03-14");
  await Promise.all([
    session.page.waitForEvent("load"),
    form.getByRole("button", { name: "Add player" }).click(),
  ]);
  expect(rosterNames(scenario)).toContain(name);
  const text = await openFresh(session, ROSTER_PAGE);
  const card = await rosterCard(session, name);
  expect(await card.innerText()).toMatch(/Age \d+/u);
  for (const spelling of dateSpellings("2018-03-14")) expect(text.includes(spelling)).toBe(false);
  await expectHtmlLacks(session.page, dateSpellings("2018-03-14"));
}

async function importCsv(scenario: Scenario, session: RoleSession, prefix: string) {
  const [casey] = scenario.query<{ birth_date: string }>(
    "SELECT birth_date FROM participants WHERE id = ?",
    CHILDREN.casey.participantId,
  );
  const csv = [
    "child_name,birth_date,guardian1_name,guardian1_relationship",
    `${prefix} One,2018-04-01,${prefix} Ida,parent`,
    `${prefix} Two,,,`,
    `${prefix} Bad,2018-13-45,,`,
    `${CHILDREN.casey.displayName},${casey?.birth_date ?? ""},,`,
  ].join("\n");
  await openFresh(session, ROSTER_PAGE);
  const form = main(session.page).getByRole("form", { name: "Import a roster" });
  await form.getByLabel("Or paste the rows").fill(csv);
  await form.getByRole("button", { name: "Preview import" }).click();
  await waitForStatus(
    session.page,
    /2 ready · 1 already on the roster · 0 repeated · 1 need a fix/u,
  );
  const previewText = await form.getByRole("table", { name: "Import preview" }).innerText();
  expect(previewText).toContain(`${prefix} One`);
  expect(previewText).toContain("Hidden until fixed");
  expect(previewText).toContain("Needs a fix");
  expect(previewText.includes(`${prefix} Bad`)).toBe(false);
  expect(rosterNames(scenario)).not.toContain(`${prefix} One`);

  await Promise.all([
    session.page.waitForEvent("load"),
    form.getByRole("button", { name: "Import 2 players" }).click(),
  ]);
  const text = await openFresh(session, ROSTER_PAGE);
  expect(text).toContain(`${prefix} One`);
  expect(text).toContain(`${prefix} Two`);
  expect(text).toContain(`${prefix} Ida (parent)`);
  expect(text.includes(`${prefix} Bad`)).toBe(false);
  await expectHtmlLacks(session.page, dateSpellings("2018-04-01"));
  const names = rosterNames(scenario);
  expect(names).toContain(`${prefix} One`);
  expect(names).toContain(`${prefix} Two`);
  expect(names).not.toContain(`${prefix} Bad`);
  expect(names.filter((name) => name === CHILDREN.casey.displayName)).toHaveLength(1);
}

async function linkGuardian(scenario: Scenario, session: RoleSession, guardian: string) {
  await openFresh(session, ROSTER_PAGE);
  const card = await rosterCard(session, CHILDREN.casey.displayName);
  await card.getByText("Link a guardian", { exact: true }).click();
  const form = card.getByRole("form", {
    name: `Link a guardian to ${CHILDREN.casey.displayName}`,
  });
  await form.getByLabel("Guardian name").fill(guardian);
  await form.getByLabel("Relationship").selectOption("caregiver");
  await Promise.all([
    session.page.waitForEvent("load"),
    form.getByRole("button", { name: "Link guardian" }).click(),
  ]);
  await openFresh(session, ROSTER_PAGE);
  expect(await (await rosterCard(session, CHILDREN.casey.displayName)).innerText()).toContain(
    `${guardian} (caregiver)`,
  );
  expect(guardianNames(scenario, CHILDREN.casey.participantId)).toContain(
    `${guardian} (caregiver)`,
  );
}

function skillCardPath(participantId: string, teamId: string = FALCONS.teamId): string {
  return `/api/teams/${teamId}/participants/${participantId}/skill-card`;
}

async function refuseCardRead(scenario: Scenario, role: Role, status: number, error: string) {
  await asRole(scenario, role, async (session) => {
    for (const child of FALCONS_CHILDREN) {
      const reply = await refused(session, "GET", skillCardPath(child.participantId), undefined, [
        status,
      ]);
      expect(reply.body).toEqual({ error });
      expect(reply.text.includes(child.displayName)).toBe(false);
    }
  });
  await asRole(scenario, "parent", async (session) => {
    const reply = await session.api("GET", skillCardPath(CHILDREN.avery.participantId));
    expect(reply.status).toBe(200);
  });
}

async function expectReadOnlyCard(session: RoleSession, participantId: string, name: string) {
  const text = await openFresh(session, cardPath(participantId));
  expect(text).toContain(name);
  const card = main(session.page).locator('section[aria-label="Player card"]');
  await card.waitFor();
  expect(await main(session.page).locator("form, input, textarea, select").count()).toBe(0);
  expect(await main(session.page).getByRole("button").count()).toBe(0);
}

async function refuseRosterWrites(session: RoleSession, statuses: readonly number[]) {
  await refused(
    session,
    "POST",
    `${SEASON_API}/participants`,
    { displayName: "Refused Player" },
    statuses,
  );
  await refused(
    session,
    "POST",
    `${SEASON_API}/roster/import/preview`,
    { csv: "child_name\nRefused Import\n" },
    statuses,
  );
  await refused(
    session,
    "POST",
    `${SEASON_API}/roster/import`,
    { rows: [{ displayName: "Refused Import", guardians: [] }] },
    statuses,
  );
  await refused(
    session,
    "POST",
    `/api/participants/${CHILDREN.avery.participantId}/guardians`,
    { displayName: "Refused Guardian", relationship: "parent" },
    statuses,
  );
}

function expectNoRefusedWrites(scenario: Scenario): void {
  const names = rosterNames(scenario);
  expect(names.includes("Refused Player") || names.includes("Refused Import")).toBe(false);
  expect(guardianNames(scenario, CHILDREN.avery.participantId).join()).not.toContain("Refused");
}

describe("roster as owner (head-coach)", () => {
  const scenario = useScenario();

  test("lists every Falcons child with an age and guardians and never a birth date", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      const text = await openFresh(session, ROSTER_PAGE);
      expect(text).toContain("coach view");
      for (const child of FALCONS_CHILDREN) {
        const card = await rosterCard(session, child.displayName);
        expect(await card.innerText()).toMatch(/Age \d+/u);
      }
      expect(await (await rosterCard(session, CHILDREN.avery.displayName)).innerText()).toContain(
        "Pat Parent (parent)",
      );
      await expectHtmlLacks(session.page, seededBirthDates(scenario()));
    });
  });

  test("adds a player with a birth date, and a fresh load shows the age but not the date", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      addPlayer(scenario(), session, "E2E Owner Added"),
    );
  });

  test("previews a CSV with a bad row and a known child, imports only the good rows, and a fresh load lists them", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      importCsv(scenario(), session, "E2E Import"),
    );
  });

  test("links a guardian to a child, and a fresh load lists the guardian", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      linkGuardian(scenario(), session, "E2E Linked Guardian"),
    );
  });

  test("reads every child's player card with no control on it and no birth date", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      for (const child of FALCONS_CHILDREN) {
        await expectReadOnlyCard(session, child.participantId, child.displayName);
        await expectHtmlLacks(session.page, seededBirthDates(scenario()));
      }
    });
  });

  test("server refuses a coach's write to a child's card through the dev skill-event route (404); lesson-answers.test.ts covers the production write", async () => {
    const before = skillEventCount(scenario(), CHILDREN.avery.participantId);
    await asRole(scenario(), "head-coach", async (session) => {
      await refused(
        session,
        "POST",
        skillEventsPath(CHILDREN.avery.participantId),
        { events: [] },
        [404],
      );
    });
    expect(skillEventCount(scenario(), CHILDREN.avery.participantId)).toBe(before);
  });
});

describe("roster as co-coach (co-coach)", () => {
  const scenario = useScenario();

  test("adds a player, and a fresh load shows the age but not the date", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      addPlayer(scenario(), session, "E2E Cocoach Added"),
    );
  });

  test("reads a child's player card with no control on it", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      expectReadOnlyCard(session, CHILDREN.casey.participantId, CHILDREN.casey.displayName),
    );
  });

  test("previews a CSV, imports only the good rows, and a fresh load lists them", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      importCsv(scenario(), session, "E2E Cocoach Import"),
    );
  });

  test("links a guardian to a child, and a fresh load lists the guardian", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      linkGuardian(scenario(), session, "E2E Cocoach Guardian"),
    );
  });

  test("server refuses a co-coach's write to a child's card through the dev skill-event route (404); lesson-answers.test.ts covers the production write", async () => {
    const before = skillEventCount(scenario(), CHILDREN.blake.participantId);
    await asRole(scenario(), "co-coach", async (session) => {
      await refused(
        session,
        "POST",
        skillEventsPath(CHILDREN.blake.participantId),
        { events: [] },
        [404],
      );
    });
    expect(skillEventCount(scenario(), CHILDREN.blake.participantId)).toBe(before);
  });
});

describe("roster as guardian of two (parent)", () => {
  const scenario = useScenario();

  test("lists only their own two children, with no coach tools and no birth date", async () => {
    await asRole(scenario(), "parent", async (session) => {
      const text = await openFresh(session, ROSTER_PAGE);
      expect(text).toContain("your children");
      expect(text).toContain(CHILDREN.avery.displayName);
      expect(text).toContain(CHILDREN.blake.displayName);
      expect(text.includes(CHILDREN.casey.displayName)).toBe(false);
      await expectNoButton(session.page, "Add player");
      await expectNoButton(session.page, "Preview import");
      expect(await main(session.page).getByText("Link a guardian").count()).toBe(0);
      await expectHtmlLacks(session.page, [
        CHILDREN.casey.displayName,
        ...seededBirthDates(scenario()),
      ]);
    });
  });

  test("opens their own children's cards, and another child's card answers 404 with no name: proves the card read guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      for (const own of [CHILDREN.avery, CHILDREN.blake]) {
        const text = await openFresh(session, cardPath(own.participantId));
        expect(text).toContain(own.displayName);
        await main(session.page).locator('section[aria-label="Player card"]').waitFor();
        const reply = await session.api("GET", skillCardPath(own.participantId));
        expect(`${own.displayName}: ${reply.status}`).toBe(`${own.displayName}: 200`);
      }
      await session.open(cardPath(CHILDREN.casey.participantId), 404);
      await expectHtmlLacks(session.page, [CHILDREN.casey.displayName]);
      await refused(
        session,
        "GET",
        `/api/teams/${FALCONS.teamId}/participants/${CHILDREN.casey.participantId}/skill-card`,
      );
    });
  });

  test("the roster API lists exactly Avery, Blake and Casey, with private fields for Avery and Blake only", async () => {
    await asRole(scenario(), "parent", async (session) => {
      const reply = await session.api("GET", `${SEASON_API}/roster`);
      expect(reply.status).toBe(200);
      const roster = (reply.body as { roster: RosterApiEntry[] }).roster;
      expect(roster.map((entry) => entry.participantId).toSorted()).toEqual(
        FALCONS_CHILDREN.map((child) => child.participantId).toSorted(),
      );
      const entry = (participantId: string) =>
        roster.find((candidate) => candidate.participantId === participantId);
      const casey = entry(CHILDREN.casey.participantId);
      expect(casey?.birthDate).toBeUndefined();
      expect(casey?.guardians).toEqual([]);
      expect(casey?.guardianInvitations).toBeUndefined();
      for (const own of [CHILDREN.avery, CHILDREN.blake]) {
        const row = entry(own.participantId);
        expect(`${own.displayName}: ${typeof row?.birthDate}`).toBe(`${own.displayName}: string`);
        expect(row?.guardians.map((guardian) => guardian.displayName)).toContain("Pat Parent");
        expect(row?.guardianInvitations).toBeDefined();
      }
    });
  });

  test("server refuses add, import preview, import and guardian link to a guardian (404): proves the roster manage guard", async () => {
    await asRole(scenario(), "parent", (session) => refuseRosterWrites(session, [404]));
    expectNoRefusedWrites(scenario());
  });
});

describe("roster as second-team guardian (second-team-guardian)", () => {
  const scenario = useScenario();

  test("lists only Quinn on the Comets roster", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      const text = await openFresh(session, COMETS_ROSTER_PAGE);
      expect(text).toContain(CHILDREN.quinn.displayName);
      expect(text.includes(CHILDREN.jordan.displayName)).toBe(false);
      await expectHtmlLacks(session.page, seededBirthDates(scenario()));
    });
  });

  test("server refuses the Falcons roster read and every Falcons roster write (404): proves the team membership guard", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(session, "GET", `${SEASON_API}/roster`, undefined, [404]);
      await refuseRosterWrites(session, [404]);
    });
    expectNoRefusedWrites(scenario());
  });
});

describe("roster as second-team guardian on the Comets (second-team-guardian)", () => {
  const scenario = useScenario();
  const cometsSeason = `/api/teams/${COMETS.teamId}/seasons/${COMETS.seasonId}`;

  function cometsRosterNames(): string[] {
    return scenario()
      .query<{ display_name: string }>(
        "SELECT people.display_name FROM memberships JOIN participants ON participants.id = memberships.member_participant_id JOIN people ON people.id = participants.person_id WHERE memberships.team_id = ? AND memberships.status = 'active' ORDER BY people.display_name",
        COMETS.teamId,
      )
      .map((row) => row.display_name);
  }

  test("server refuses add, import preview, import and guardian link on the Comets to a guardian (404), and the Comets owner's same calls succeed: proves the roster manage guard", async () => {
    const before = cometsRosterNames();
    const quinnGuardians = guardianNames(scenario(), CHILDREN.quinn.participantId);
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(
        session,
        "POST",
        `${cometsSeason}/participants`,
        { displayName: "Refused Comet" },
        [404],
      );
      await refused(
        session,
        "POST",
        `${cometsSeason}/roster/import/preview`,
        { csv: "child_name\nRefused Comet Import\n" },
        [404],
      );
      await refused(
        session,
        "POST",
        `${cometsSeason}/roster/import`,
        { rows: [{ displayName: "Refused Comet Import", guardians: [] }] },
        [404],
      );
      await refused(
        session,
        "POST",
        `/api/participants/${CHILDREN.quinn.participantId}/guardians`,
        { displayName: "Refused Comet Guardian", relationship: "parent" },
        [404],
      );
    });
    expect(cometsRosterNames()).toEqual(before);
    expect(guardianNames(scenario(), CHILDREN.quinn.participantId)).toEqual(quinnGuardians);

    await asRole(scenario(), "default", async (session) => {
      const added = await session.api("POST", `${cometsSeason}/participants`, {
        displayName: "E2E Owner Comet",
      });
      expect(added.status).toBe(201);
      const preview = await session.api("POST", `${cometsSeason}/roster/import/preview`, {
        csv: "child_name\nE2E Owner Comet Import\n",
      });
      expect(preview.status).toBe(200);
      const imported = await session.api("POST", `${cometsSeason}/roster/import`, {
        rows: [{ displayName: "E2E Owner Comet Import", guardians: [] }],
      });
      expect(imported.status).toBe(201);
      const linked = await session.api(
        "POST",
        `/api/participants/${CHILDREN.quinn.participantId}/guardians`,
        { displayName: "E2E Owner Comet Guardian", relationship: "parent" },
      );
      expect(linked.status).toBe(201);
    });
    expect(cometsRosterNames()).toEqual(
      [...before, "E2E Owner Comet", "E2E Owner Comet Import"].toSorted(),
    );
    expect(guardianNames(scenario(), CHILDREN.quinn.participantId)).toContain(
      "E2E Owner Comet Guardian (parent)",
    );
  });
});

describe("roster as adult member (team-member)", () => {
  const scenario = useScenario();

  test("sees no children and no coach tools", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      const text = await openFresh(session, ROSTER_PAGE);
      expect(text).toContain("No children of yours here");
      await expectNoButton(session.page, "Add player");
      await expectHtmlLacks(session.page, [
        CHILDREN.avery.displayName,
        ...seededBirthDates(scenario()),
      ]);
    });
  });

  test("server refuses roster writes and every child's card to an adult member (404): proves the card read guard", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      await refuseRosterWrites(session, [404]);
      for (const child of FALCONS_CHILDREN) {
        await session.open(cardPath(child.participantId), 404);
        await expectHtmlLacks(session.page, [child.displayName]);
      }
    });
    expectNoRefusedWrites(scenario());
  });
});

describe("roster as stranger (stranger)", () => {
  const scenario = useScenario();

  test("server refuses every Falcons card API read to a stranger (404), and the guardian's read on the same route succeeds: proves the team membership guard", async () => {
    await refuseCardRead(scenario(), "stranger", 404, "team not found");
  });

  test("server refuses the Falcons roster read and every roster write to a stranger (404)", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await refused(session, "GET", `${SEASON_API}/roster`, undefined, [404]);
      await refuseRosterWrites(session, [404]);
    });
    expectNoRefusedWrites(scenario());
  });
});

describe("roster as signed-out visitor", () => {
  const scenario = useScenario();
  const signedOut: Role = "signed-out";

  test("server answers 401 to every roster call, and the card page shows no child", async () => {
    await asRole(scenario(), signedOut, async (session) => {
      await refused(session, "GET", `${SEASON_API}/roster`, undefined, [401]);
      await refuseRosterWrites(session, [401]);
      await session.open(cardPath(CHILDREN.avery.participantId));
      expect(await mainText(session.page)).toContain("Signed out");
      await expectHtmlLacks(session.page, [CHILDREN.avery.displayName]);
    });
  });

  test("server answers 401 to every card API read without a session, and the guardian's read on the same route succeeds: proves the session guard", async () => {
    await refuseCardRead(scenario(), signedOut, 401, "authentication required");
  });
});

describe("roster: no birth date on any signed-in page", () => {
  const scenario = useScenario();
  const pages = ["/app/team", "/app/roster", "/app/schedule", "/app/duties"];
  const roles: readonly Role[] = [
    "head-coach",
    "co-coach",
    "parent",
    "second-team-guardian",
    "team-member",
  ];

  for (const role of roles) {
    test(`${role} sees no seeded birth date on team, roster, schedule or duties`, async () => {
      await asRole(scenario(), role, async (session) => {
        for (const path of pages) {
          await openFresh(session, path);
          await expectHtmlLacks(session.page, seededBirthDates(scenario()));
        }
      });
    });
  }

  const overviewChild = {
    "head-coach": CHILDREN.avery,
    "co-coach": CHILDREN.avery,
    parent: CHILDREN.avery,
    "second-team-guardian": CHILDREN.quinn,
  } as const;

  for (const [role, child] of Object.entries(overviewChild)) {
    test(`the /app overview shows ${role} ${child.displayName}'s age and no birth date`, async () => {
      await asRole(scenario(), role as Role, async (session) => {
        const text = await openFresh(session, "/app");
        expect(text).toContain(child.displayName);
        expect(text).toContain(`Age ${seededAge(scenario(), child.participantId)}`);
        expect(text).not.toContain("Born ");
        await expectHtmlLacks(session.page, seededBirthDates(scenario()));
      });
    });
  }

  for (const role of ["team-member"] as const) {
    test(`${role} sees no birth date on the /app overview`, async () => {
      await asRole(scenario(), role, async (session) => {
        await openFresh(session, "/app");
        await expectHtmlLacks(session.page, seededBirthDates(scenario()));
      });
    });
  }

  test("the roster page never shows a date for a child", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, ROSTER_PAGE);
      expect(
        await main(session.page).getByRole("list", { name: "Players" }).innerText(),
      ).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
      await button(session.page, "Add player").waitFor();
    });
  });
});
