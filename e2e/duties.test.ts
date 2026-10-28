import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Locator } from "playwright-core";

import { SEED_SCHEDULE } from "../apps/web/app/dev/seed-personas";
import {
  COMETS,
  FALCONS,
  OCCURRENCES,
  SLOTS,
  expectNoButton,
  main,
  openFresh,
  persona,
  slotAssignee,
  teamApi,
  waitForStatus,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import type { Scenario } from "./support/scenario";
import { asRole, openSession, refused } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(90_000);

const DUTIES_PAGE = `/app/duties?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`;
const COMETS_DUTIES_PAGE = `/app/duties?team=${COMETS.teamId}&season=${COMETS.seasonId}`;
const HAWKS = SEED_SCHEDULE.gameTitles[0];
const OWLS = SEED_SCHEDULE.gameTitles[1];
const CLINIC = SEED_SCHEDULE.secondTeamEventTitle;

function slotsApi(teamId: string, occurrenceId: string, rest = ""): string {
  return teamApi(teamId, `/occurrences/${occurrenceId}/duty-slots${rest}`);
}

function slotRow(session: RoleSession, eventTitle: string, label: string): Locator {
  return main(session.page)
    .getByRole("list", { name: `Duties for ${eventTitle}` })
    .getByRole("listitem")
    .filter({ has: session.page.getByText(label, { exact: true }) });
}

async function slotState(session: RoleSession, eventTitle: string, label: string) {
  return slotRow(session, eventTitle, label).first().getAttribute("data-slot-state");
}

function slotsOn(scenario: Scenario, occurrenceId: string, label: string): number {
  return scenario.query(
    "SELECT id FROM duty_slots WHERE occurrence_id = ? AND label = ?",
    occurrenceId,
    label,
  ).length;
}

async function claimAndRelease(
  scenario: Scenario,
  session: RoleSession,
  page: string,
  eventTitle: string,
  label: string,
  slotId: string,
) {
  await openFresh(session, page);
  await slotRow(session, eventTitle, label)
    .getByRole("button", { name: `Claim ${label}` })
    .click();
  await waitForStatus(session.page, `You claimed ${label}.`);
  expect(slotAssignee(scenario, slotId)).toBe(persona(session.role).personId);

  await openFresh(session, page);
  expect(await slotState(session, eventTitle, label)).toBe("mine");
  await main(session.page)
    .getByRole("list", { name: "My duties" })
    .getByText(label)
    .first()
    .waitFor();
  await slotRow(session, eventTitle, label).getByRole("button", { name: "Release" }).click();
  await waitForStatus(session.page, `You released ${label}. It is open again.`);
  expect(slotAssignee(scenario, slotId)).toBeNull();

  await openFresh(session, page);
  expect(await slotState(session, eventTitle, label)).toBe("open");
}

async function refuseCoachDutyWrites(
  session: RoleSession,
  statuses: readonly number[],
): Promise<void> {
  await refused(
    session,
    "POST",
    slotsApi(FALCONS.teamId, OCCURRENCES.hawks),
    { label: "Refused slot" },
    statuses,
  );
  await refused(
    session,
    "POST",
    slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksSnacks}/assignment`),
    { assigneePersonId: null },
    statuses,
  );
  await refused(
    session,
    "POST",
    slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksFieldSetup}/assignment`),
    { assigneePersonId: persona(session.role === "signed-out" ? "parent" : session.role).personId },
    statuses,
  );
}

function expectNoCoachDutyWrites(scenario: Scenario): void {
  expect(slotsOn(scenario, OCCURRENCES.hawks, "Refused slot")).toBe(0);
  expect(slotAssignee(scenario, SLOTS.hawksSnacks)).toBe(persona("parent").personId);
  expect(slotAssignee(scenario, SLOTS.hawksFieldSetup)).toBeNull();
}

describe("duties as owner (head-coach)", () => {
  const scenario = useScenario();

  test("claims and releases an open slot, and a fresh load shows each change", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      claimAndRelease(scenario(), session, DUTIES_PAGE, OWLS, "Scorebook", SLOTS.owlsScorebook),
    );
  });

  test("adds a duty slot to a game, and a fresh load lists it open", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      const card = main(session.page)
        .locator("li")
        .filter({
          has: session.page.getByRole("list", { name: `Duties for ${HAWKS}` }),
        });
      await card.getByText("Add a duty slot", { exact: true }).click();
      const form = card.getByRole("form", { name: "Add a duty slot" });
      await form.getByLabel("Duty", { exact: true }).fill("E2E Water");
      await form.getByLabel("Instructions (optional)").fill("Two coolers");
      await form.getByRole("button", { name: "Add slot" }).click();
      await waitForStatus(session.page, "Added E2E Water.");
      await openFresh(session, DUTIES_PAGE);
      expect(await slotState(session, HAWKS, "E2E Water")).toBe("open");
      expect(await slotRow(session, HAWKS, "E2E Water").innerText()).toContain("Two coolers");
    });
    expect(slotsOn(scenario(), OCCURRENCES.hawks, "E2E Water")).toBe(1);
  });

  test("assigns an open slot to an adult and unassigns it, and a fresh load shows each change", async () => {
    const member = persona("team-member");
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      const form = slotRow(session, HAWKS, "Field setup").getByRole("form", {
        name: "Assign Field setup",
      });
      await form.getByLabel("Assign an adult").selectOption(member.personId);
      await form.getByRole("button", { name: "Assign", exact: true }).click();
      await waitForStatus(session.page, `${member.displayName} now holds Field setup.`);
      expect(slotAssignee(scenario(), SLOTS.hawksFieldSetup)).toBe(member.personId);

      await openFresh(session, DUTIES_PAGE);
      expect(await slotRow(session, HAWKS, "Field setup").innerText()).toContain(
        `Claimed by ${member.displayName}`,
      );
      await slotRow(session, HAWKS, "Field setup")
        .getByRole("button", { name: "Unassign" })
        .click();
      await waitForStatus(session.page, "Field setup is open again.");
      expect(slotAssignee(scenario(), SLOTS.hawksFieldSetup)).toBeNull();

      await openFresh(session, DUTIES_PAGE);
      expect(await slotState(session, HAWKS, "Field setup")).toBe("open");
    });
  });

  test("reassigns a slot another adult claimed, and a fresh load shows the new holder", async () => {
    const coCoach = persona("co-coach");
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      const form = slotRow(session, HAWKS, "Snacks").getByRole("form", { name: "Assign Snacks" });
      await form.getByLabel("Assign an adult").selectOption(coCoach.personId);
      await form.getByRole("button", { name: "Assign", exact: true }).click();
      await waitForStatus(session.page, `${coCoach.displayName} now holds Snacks.`);
      await openFresh(session, DUTIES_PAGE);
      expect(await slotRow(session, HAWKS, "Snacks").innerText()).toContain(
        `Claimed by ${coCoach.displayName}`,
      );
    });
    expect(slotAssignee(scenario(), SLOTS.hawksSnacks)).toBe(coCoach.personId);
  });
});

describe("duties as co-coach (co-coach)", () => {
  const scenario = useScenario();

  test("adds, assigns and unassigns a slot, and a fresh load shows each change", async () => {
    const parent = persona("parent");
    await asRole(scenario(), "co-coach", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      const card = main(session.page)
        .locator("li")
        .filter({
          has: session.page.getByRole("list", { name: `Duties for ${OWLS}` }),
        });
      await card.getByText("Add a duty slot", { exact: true }).click();
      const add = card.getByRole("form", { name: "Add a duty slot" });
      await add.getByLabel("Duty", { exact: true }).fill("E2E Chalk");
      await add.getByRole("button", { name: "Add slot" }).click();
      await waitForStatus(session.page, "Added E2E Chalk.");

      await openFresh(session, DUTIES_PAGE);
      const assign = slotRow(session, OWLS, "E2E Chalk").getByRole("form", {
        name: "Assign E2E Chalk",
      });
      await assign.getByLabel("Assign an adult").selectOption(parent.personId);
      await assign.getByRole("button", { name: "Assign", exact: true }).click();
      await waitForStatus(session.page, `${parent.displayName} now holds E2E Chalk.`);

      await openFresh(session, DUTIES_PAGE);
      await slotRow(session, OWLS, "E2E Chalk").getByRole("button", { name: "Unassign" }).click();
      await waitForStatus(session.page, "E2E Chalk is open again.");
      await openFresh(session, DUTIES_PAGE);
      expect(await slotState(session, OWLS, "E2E Chalk")).toBe("open");
    });
    const [slot] = scenario().query<{ assignee_person_id: string | null }>(
      "SELECT assignee_person_id FROM duty_slots WHERE occurrence_id = ? AND label = 'E2E Chalk'",
      OCCURRENCES.owls,
    );
    expect(slot).toEqual({ assignee_person_id: null });
  });
});

describe("duties as guardian of two (parent)", () => {
  const scenario = useScenario();

  test("claims and releases an open slot, and a fresh load shows each change", async () => {
    await asRole(scenario(), "parent", (session) =>
      claimAndRelease(
        scenario(),
        session,
        DUTIES_PAGE,
        HAWKS,
        "Field setup",
        SLOTS.hawksFieldSetup,
      ),
    );
  });

  test("sees no add, assign or unassign control", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      expect(await main(session.page).getByText("Add a duty slot").count()).toBe(0);
      expect(await main(session.page).getByText("Assign an adult").count()).toBe(0);
      await expectNoButton(session.page, "Unassign");
      expect(await slotRow(session, OWLS, "Snacks").getByRole("button").count()).toBe(0);
    });
  });

  test("server refuses add, assign and unassign to a guardian (404): proves the duty manage guard", async () => {
    await asRole(scenario(), "parent", (session) => refuseCoachDutyWrites(session, [404]));
    expectNoCoachDutyWrites(scenario());
  });

  test("server refuses to release a slot another adult holds (404/409): proves the holder guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await refused(
        session,
        "POST",
        slotsApi(FALCONS.teamId, OCCURRENCES.owls, `/${SLOTS.owlsSnacks}/release`),
        undefined,
        [404, 409],
      );
    });
    expect(slotAssignee(scenario(), SLOTS.owlsSnacks)).toBe(persona("team-member").personId);
  });
});

describe("duties race: two adults claim one open slot", () => {
  const scenario = useScenario();

  test("the second click on a stale board loses, sees who won, and the slot keeps one holder", async () => {
    const parent = await openSession(scenario(), "parent");
    const member = await openSession(scenario(), "team-member");
    try {
      await openFresh(parent, DUTIES_PAGE);
      await openFresh(member, DUTIES_PAGE);
      member.allowFailedResponse(409, /\/duty-slots\/.+\/claim$/u);

      await slotRow(parent, OWLS, "Scorebook")
        .getByRole("button", { name: "Claim Scorebook" })
        .click();
      await waitForStatus(parent.page, "You claimed Scorebook.");
      await slotRow(member, OWLS, "Scorebook")
        .getByRole("button", { name: "Claim Scorebook" })
        .click();
      await waitForStatus(member.page, `${persona("parent").displayName} claimed Scorebook first.`);
      expect(await slotState(member, OWLS, "Scorebook")).toBe("taken");
      expect(slotAssignee(scenario(), SLOTS.owlsScorebook)).toBe(persona("parent").personId);

      await openFresh(member, DUTIES_PAGE);
      expect(await slotRow(member, OWLS, "Scorebook").innerText()).toContain(
        `Claimed by ${persona("parent").displayName}`,
      );
      expect(parent.problems()).toEqual([]);
      expect(member.problems()).toEqual([]);
    } finally {
      await parent.close();
      await member.close();
    }
  });

  test("two simultaneous claims through the API: exactly one wins with 200 and the other gets 409", async () => {
    const coCoach = await openSession(scenario(), "co-coach");
    const member = await openSession(scenario(), "team-member");
    try {
      const path = slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksFieldSetup}/claim`);
      coCoach.allowFailedResponse(409, path);
      member.allowFailedResponse(409, path);
      await coCoach.api("GET", "/styles.css");
      await member.api("GET", "/styles.css");
      const [first, second] = await Promise.all([
        coCoach.api("POST", path),
        member.api("POST", path),
      ]);
      expect([first.status, second.status].toSorted()).toEqual([200, 409]);
      const winner = first.status === 200 ? "co-coach" : "team-member";
      expect(slotAssignee(scenario(), SLOTS.hawksFieldSetup)).toBe(persona(winner).personId);
      expect(coCoach.problems()).toEqual([]);
      expect(member.problems()).toEqual([]);
    } finally {
      await coCoach.close();
      await member.close();
    }
  });
});

describe("duties as second-team guardian (second-team-guardian)", () => {
  const scenario = useScenario();

  test("claims and releases the Comets clinic slot, and a fresh load shows each change", async () => {
    await asRole(scenario(), "second-team-guardian", (session) =>
      claimAndRelease(
        scenario(),
        session,
        COMETS_DUTIES_PAGE,
        CLINIC,
        "Snacks",
        SLOTS.clinicSnacks,
      ),
    );
  });

  test("server refuses a Falcons claim and every Falcons duty write (404): proves the team membership guard", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(session, "GET", slotsApi(FALCONS.teamId, OCCURRENCES.hawks), undefined, [404]);
      await refused(
        session,
        "POST",
        slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksFieldSetup}/claim`),
        undefined,
        [404],
      );
      await refuseCoachDutyWrites(session, [404]);
    });
    expectNoCoachDutyWrites(scenario());
  });
});

describe("duties as adult member (team-member)", () => {
  const scenario = useScenario();

  test("releases the seeded Owls snacks slot, claims it back, and a fresh load shows each change", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      await openFresh(session, DUTIES_PAGE);
      await slotRow(session, OWLS, "Snacks").getByRole("button", { name: "Release" }).click();
      await waitForStatus(session.page, "You released Snacks. It is open again.");
      expect(slotAssignee(scenario(), SLOTS.owlsSnacks)).toBeNull();
    });
    await asRole(scenario(), "team-member", (session) =>
      claimAndRelease(scenario(), session, DUTIES_PAGE, OWLS, "Snacks", SLOTS.owlsSnacks),
    );
  });

  test("server refuses add, assign and unassign to an adult member (404): proves the duty manage guard", async () => {
    await asRole(scenario(), "team-member", (session) => refuseCoachDutyWrites(session, [404]));
    expectNoCoachDutyWrites(scenario());
  });
});

describe("duties as stranger (stranger)", () => {
  const scenario = useScenario();

  test("server refuses every Falcons duty call to a stranger (404)", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await refused(session, "GET", slotsApi(FALCONS.teamId, OCCURRENCES.hawks), undefined, [404]);
      await refused(
        session,
        "POST",
        slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksFieldSetup}/claim`),
        undefined,
        [404],
      );
      await refuseCoachDutyWrites(session, [404]);
    });
    expectNoCoachDutyWrites(scenario());
  });
});

describe("duties as signed-out visitor", () => {
  const scenario = useScenario();
  const signedOut: Role = "signed-out";

  test("server answers 401 to every duty call", async () => {
    await asRole(scenario(), signedOut, async (session) => {
      await refused(session, "GET", slotsApi(FALCONS.teamId, OCCURRENCES.hawks), undefined, [401]);
      await refused(
        session,
        "POST",
        slotsApi(FALCONS.teamId, OCCURRENCES.hawks, `/${SLOTS.hawksFieldSetup}/claim`),
        undefined,
        [401],
      );
      await refuseCoachDutyWrites(session, [401]);
    });
    expectNoCoachDutyWrites(scenario());
  });
});
