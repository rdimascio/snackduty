import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  APP_SECTIONS,
  CHILDREN,
  COMETS,
  FALCONS,
  OCCURRENCES,
  cardPath,
  eventPath,
  expectAbsentText,
  expectHydrated,
  expectNoSkeleton,
  expectRenderedNotFound,
  expectVisibleText,
  mainText,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import { asRole } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(60_000);

type SectionPath = (typeof APP_SECTIONS)[number]["path"];

interface RoleView {
  readonly role: Role;
  readonly title: string;
  readonly signedOutStatus?: Partial<Record<SectionPath, number>>;
  readonly shows: Partial<Record<SectionPath, readonly string[]>>;
  readonly hides: Partial<Record<SectionPath, readonly string[]>>;
}

const coachShows = {
  "/app/roster": ["coach view", "Add a player", "Import from CSV", "Casey Scenario"],
  "/app/schedule": ["Create event", "Export CSV"],
  "/app/duties": ["Add a duty slot", "Assign an adult"],
} as const;

const ROLE_VIEWS: readonly RoleView[] = [
  {
    role: "head-coach",
    title: "owner",
    shows: {
      "/app": [FALCONS.name, "Avery Scenario", "Casey Scenario"],
      "/app/team": ["Owner", "Send invitation", "Make Max Member a co-coach", "Create a season"],
      ...coachShows,
    },
    hides: {},
  },
  {
    role: "co-coach",
    title: "co-coach",
    shows: {
      "/app": [FALCONS.name, "Casey Scenario"],
      "/app/team": ["Co-coach", "Create a season", "Calendar feed"],
      ...coachShows,
    },
    hides: {
      "/app/team": ["Send invitation", "Make Max Member a co-coach", "Pending invitations"],
    },
  },
  {
    role: "parent",
    title: "guardian of two",
    shows: {
      "/app": [FALCONS.name, "Avery Scenario", "Blake Scenario"],
      "/app/team": ["Adult member", "Calendar feed"],
      "/app/roster": ["your children", "Avery Scenario", "Blake Scenario"],
      "/app/schedule": ["Practice"],
      "/app/duties": ["My duties", "Claim Field setup"],
    },
    hides: {
      "/app/team": ["Send invitation", "Create a season", "a co-coach"],
      "/app/roster": ["Casey Scenario", "Add a player", "Import from CSV", "Link a guardian"],
      "/app/schedule": ["Create event", "Export CSV"],
      "/app/duties": ["Add a duty slot", "Assign an adult", "Unassign"],
    },
  },
  {
    role: "second-team-guardian",
    title: "second-team guardian",
    shows: {
      "/app": [COMETS.name, "Quinn Scenario"],
      "/app/team": [COMETS.name, "Adult member"],
      "/app/roster": ["Quinn Scenario"],
      "/app/schedule": ["Sunday skills clinic"],
      "/app/duties": ["Sunday skills clinic", "Claim Snacks"],
    },
    hides: {
      "/app": [FALCONS.name, "Avery Scenario"],
      "/app/team": [FALCONS.name, "Send invitation", "Create a season"],
      "/app/roster": [FALCONS.name, "Jordan Scenario", "Avery Scenario", "Add a player"],
      "/app/schedule": [FALCONS.name, "Game vs. Scenario Hawks (home)", "Create event"],
      "/app/duties": [FALCONS.name, "Add a duty slot"],
    },
  },
  {
    role: "team-member",
    title: "adult member",
    shows: {
      "/app": [FALCONS.name],
      "/app/team": ["Adult member", "Max Member (you)"],
      "/app/roster": ["No children of yours here"],
      "/app/schedule": ["Practice"],
      "/app/duties": ["My duties"],
    },
    hides: {
      "/app/team": ["Send invitation", "Create a season"],
      "/app/roster": ["Avery Scenario", "Add a player"],
      "/app/schedule": ["Create event", "Export CSV"],
      "/app/duties": ["Add a duty slot", "Assign an adult"],
    },
  },
  {
    role: "stranger",
    title: "stranger",
    shows: {
      "/app": ["No team yet"],
      "/app/team": ["No team yet"],
      "/app/roster": ["No team yet"],
      "/app/schedule": ["No team yet"],
      "/app/duties": ["No team yet"],
    },
    hides: {
      "/app": [FALCONS.name, COMETS.name],
      "/app/team": [FALCONS.name, COMETS.name],
      "/app/roster": [FALCONS.name, COMETS.name],
      "/app/schedule": [FALCONS.name, COMETS.name],
      "/app/duties": [FALCONS.name, COMETS.name],
    },
  },
  {
    role: "signed-out",
    title: "signed-out visitor",
    signedOutStatus: { "/app/schedule": 401 },
    shows: {
      "/app": ["Signed out"],
      "/app/team": ["Signed out"],
      "/app/roster": ["Signed out"],
      "/app/schedule": ["Signed out"],
      "/app/duties": ["Signed out"],
    },
    hides: {
      "/app": [FALCONS.name, COMETS.name],
      "/app/team": [FALCONS.name, COMETS.name],
      "/app/roster": [FALCONS.name, COMETS.name],
      "/app/schedule": [FALCONS.name, COMETS.name],
      "/app/duties": [FALCONS.name, COMETS.name],
    },
  },
];

async function expectCurrentSection(session: RoleSession, label: string): Promise<void> {
  const sidebar = session.page.locator('aside nav[aria-label="Team workspace"]');
  await sidebar.locator('a[aria-current="page"]').waitFor({ timeout: 10_000 });
  const current = await sidebar.locator('a[aria-current="page"]').allInnerTexts();
  expect(current).toEqual([label]);
  const links = await sidebar.locator("a").allInnerTexts();
  expect(links).toEqual(APP_SECTIONS.map((section) => section.label));
}

for (const view of ROLE_VIEWS) {
  describe(`navigation as ${view.title} (${view.role})`, () => {
    const scenario = useScenario();

    test("every sidebar link loads its section, leaves the skeleton and marks the section current", async () => {
      await asRole(scenario(), view.role, async (session) => {
        for (const section of APP_SECTIONS) {
          const status = view.signedOutStatus?.[section.path] ?? 200;
          await session.open(section.path, status);
          await expectHydrated(session.page);
          await expectNoSkeleton(session.page);
          await expectCurrentSection(session, section.label);
        }
      });
    });

    test("following the sidebar from the overview reaches every section", async () => {
      await asRole(scenario(), view.role, async (session) => {
        await session.open("/app");
        await expectHydrated(session.page);
        for (const section of APP_SECTIONS.slice(1)) {
          const status = view.signedOutStatus?.[section.path] ?? 200;
          if (status !== 200) session.allowFailedResponse(status, section.path);
          const [response] = await Promise.all([
            session.page.waitForResponse(
              (candidate) => new URL(candidate.url()).pathname === section.path,
            ),
            session.page
              .locator('aside nav[aria-label="Team workspace"]')
              .getByRole("link", { name: section.label, exact: true })
              .click(),
          ]);
          expect(response.status()).toBe(status);
          await session.page.waitForLoadState("load");
          await expectNoSkeleton(session.page);
          await expectCurrentSection(session, section.label);
        }
      });
    });

    test("each section shows this role exactly what it may see and hides the rest", async () => {
      await asRole(scenario(), view.role, async (session) => {
        for (const section of APP_SECTIONS) {
          await session.open(section.path, view.signedOutStatus?.[section.path] ?? 200);
          await expectHydrated(session.page);
          for (const text of view.shows[section.path] ?? []) {
            await expectVisibleText(session.page, text);
          }
          const body = await mainText(session.page);
          for (const text of view.hides[section.path] ?? []) {
            expect(`${section.path}: ${body.includes(text) ? text : ""}`).toBe(`${section.path}: `);
          }
        }
      });
    });
  });
}

describe("navigation: a stranger cannot open another team by id", () => {
  const scenario = useScenario();
  const falconsPages = [
    `/app/team?team=${FALCONS.teamId}`,
    `/app/roster?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`,
    `/app/schedule?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`,
    `/app/duties?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`,
    eventPath(OCCURRENCES.hawks),
    cardPath(CHILDREN.avery.participantId),
  ];

  test("every Falcons page answers 404 to the stranger and shows no Falcons name or child", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      for (const path of falconsPages) {
        await session.open(path, 404);
        await expectAbsentText(session.page, FALCONS.name);
        await expectAbsentText(session.page, CHILDREN.avery.displayName);
        const html = await session.page.content();
        expect(html.includes(CHILDREN.avery.displayName)).toBe(false);
        expect(html.includes(FALCONS.name)).toBe(false);
      }
    });
  });

  test("the Comets guardian also gets 404 for every Falcons page", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      for (const path of falconsPages) {
        await session.open(path, 404);
        expect((await session.page.content()).includes(CHILDREN.avery.displayName)).toBe(false);
      }
    });
  });

  for (const path of [
    `/app/roster?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`,
    `/app/duties?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`,
    cardPath(CHILDREN.avery.participantId),
  ]) {
    for (const role of ["stranger", "second-team-guardian"] as const) {
      test(`${path.split("?")[0]} renders the shared not-found page to ${role} with no skeleton, stack or app inline script`, async () => {
        await asRole(scenario(), role, async (session) => {
          const response = await session.open(path, 404);
          await expectRenderedNotFound(session.page, await response.text());
        });
      });
    }
  }
});
