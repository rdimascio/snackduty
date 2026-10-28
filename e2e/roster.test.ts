import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  CHILDREN,
  COMETS,
  FALCONS,
  button,
  cardPath,
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
  expect(text.includes("2018-03-14")).toBe(false);
  await expectHtmlLacks(session.page, ["2018-03-14"]);
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
    const [casey] = scenario().query<{ birth_date: string }>(
      "SELECT birth_date FROM participants WHERE id = ?",
      CHILDREN.casey.participantId,
    );
    const csv = [
      "child_name,birth_date,guardian1_name,guardian1_relationship",
      "E2E Import One,2018-04-01,Ida One,parent",
      "E2E Import Two,,,",
      "E2E Import Bad,2018-13-45,,",
      `${CHILDREN.casey.displayName},${casey?.birth_date ?? ""},,`,
    ].join("\n");
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, ROSTER_PAGE);
      const form = main(session.page).getByRole("form", { name: "Import a roster" });
      await form.getByLabel("Or paste the rows").fill(csv);
      await form.getByRole("button", { name: "Preview import" }).click();
      await waitForStatus(
        session.page,
        /2 ready · 1 already on the roster · 0 repeated · 1 need a fix/u,
      );
      const preview = form.getByRole("table", { name: "Import preview" });
      const previewText = await preview.innerText();
      expect(previewText).toContain("E2E Import One");
      expect(previewText).toContain("Hidden until fixed");
      expect(previewText).toContain("Needs a fix");
      expect(previewText.includes("E2E Import Bad")).toBe(false);
      expect(rosterNames(scenario())).not.toContain("E2E Import One");

      await Promise.all([
        session.page.waitForEvent("load"),
        form.getByRole("button", { name: "Import 2 players" }).click(),
      ]);
      const text = await openFresh(session, ROSTER_PAGE);
      expect(text).toContain("E2E Import One");
      expect(text).toContain("E2E Import Two");
      expect(text).toContain("Ida One (parent)");
      expect(text.includes("E2E Import Bad")).toBe(false);
      await expectHtmlLacks(session.page, ["2018-04-01"]);
    });
    const names = rosterNames(scenario());
    expect(names).toContain("E2E Import One");
    expect(names).toContain("E2E Import Two");
    expect(names).not.toContain("E2E Import Bad");
    expect(names.filter((name) => name === CHILDREN.casey.displayName)).toHaveLength(1);
  });

  test("links a guardian to a child, and a fresh load lists the guardian", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, ROSTER_PAGE);
      const card = await rosterCard(session, CHILDREN.casey.displayName);
      await card.getByText("Link a guardian", { exact: true }).click();
      const form = card.getByRole("form", {
        name: `Link a guardian to ${CHILDREN.casey.displayName}`,
      });
      await form.getByLabel("Guardian name").fill("E2E Linked Guardian");
      await form.getByLabel("Relationship").selectOption("caregiver");
      await Promise.all([
        session.page.waitForEvent("load"),
        form.getByRole("button", { name: "Link guardian" }).click(),
      ]);
      await openFresh(session, ROSTER_PAGE);
      expect(await (await rosterCard(session, CHILDREN.casey.displayName)).innerText()).toContain(
        "E2E Linked Guardian (caregiver)",
      );
    });
    expect(guardianNames(scenario(), CHILDREN.casey.participantId)).toContain(
      "E2E Linked Guardian (caregiver)",
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

  test("server refuses a coach's skill-event write to a child's card (404): proves the guardian-only card write guard", async () => {
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

  test("server refuses a co-coach's skill-event write to a child's card (404): proves the guardian-only card write guard", async () => {
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

  test("opens their own child's card, and another child's card answers 404 with no name: proves the card read guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      const text = await openFresh(session, cardPath(CHILDREN.avery.participantId));
      expect(text).toContain(CHILDREN.avery.displayName);
      await session.open(cardPath(CHILDREN.casey.participantId), 404);
      await expectHtmlLacks(session.page, [CHILDREN.casey.displayName]);
      await refused(
        session,
        "GET",
        `/api/teams/${FALCONS.teamId}/participants/${CHILDREN.casey.participantId}/skill-card`,
      );
    });
  });

  test("the roster API gives a guardian private fields for their own children only", async () => {
    await asRole(scenario(), "parent", async (session) => {
      const reply = await session.api("GET", `${SEASON_API}/roster`);
      expect(reply.status).toBe(200);
      const roster = (reply.body as { roster: { participantId: string; birthDate?: string }[] })
        .roster;
      const casey = roster.find((entry) => entry.participantId === CHILDREN.casey.participantId);
      expect(casey?.birthDate).toBeUndefined();
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
