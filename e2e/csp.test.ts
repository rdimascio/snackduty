import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Page } from "playwright-core";

import {
  DEV_SIGN_IN_PAGE_PATH,
  SEED_PERSONAS,
  SEED_SCHEDULE,
  SEED_TEAMS,
} from "../apps/web/app/dev/seed-personas";
import {
  BALLPLAYER_CONTENT_SECURITY_POLICY,
  SNACKDAY_CONTENT_SECURITY_POLICY,
} from "../apps/web/app/server/content-security-policy";
import {
  APP_SECTIONS,
  CHILDREN,
  OCCURRENCES,
  cardPath,
  eventPath,
  expectHydrated,
  expectNoSkeleton,
  main,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import { asRole } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(120_000);

const POSTER_TIMEOUT_MS = 15_000;
const POSTER_SELECTOR = 'section[aria-label="Lesson of the week"] img';
const REACT_PROGRESSIVE_CHUNK_SIZE = 12_800;
const LARGE_ROSTER_SIZE = 60;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function largeRosterSql(): string {
  const { teamId, seasonId } = SEED_TEAMS.coached;
  const players = `WITH RECURSIVE players(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM players WHERE n < ${LARGE_ROSTER_SIZE})`;
  return [
    `INSERT INTO people (id, display_name, status, created_at, updated_at) ${players} SELECT 'person_load_' || n, 'Roster Load ' || printf('%03d', n), 'active', ${NOW}, ${NOW} FROM players;`,
    `INSERT INTO participants (id, person_id, birth_date, status, created_at, updated_at) ${players} SELECT 'participant_load_' || n, 'person_load_' || n, '2018-06-01', 'active', ${NOW}, ${NOW} FROM players;`,
    `INSERT INTO memberships (id, team_id, season_id, member_kind, member_person_id, member_participant_id, status, created_at, updated_at) ${players} SELECT 'membership_load_' || n, '${teamId}', '${seasonId}', 'participant', NULL, 'participant_load_' || n, 'active', ${NOW}, ${NOW} FROM players;`,
  ].join("\n");
}

function largeRosterPlayer(index: number): string {
  return `Roster Load ${String(index + 1).padStart(3, "0")}`;
}

async function expectPolicy(session: RoleSession, path: string, status = 200): Promise<void> {
  const response = await session.open(path, status);
  expect(`${path}: ${response.headers()["content-security-policy"]}`).toBe(
    `${path}: ${session.brand === "ballplayer" ? BALLPLAYER_CONTENT_SECURITY_POLICY : SNACKDAY_CONTENT_SECURITY_POLICY}`,
  );
  await session.page.waitForLoadState("networkidle");
}

async function expectLayoutWrapper(page: Page): Promise<void> {
  const wrappers = await page.evaluate(() =>
    [...document.querySelectorAll("[data-lesto-layout]")].map(
      (element) => getComputedStyle(element).display,
    ),
  );
  expect(wrappers.length).toBeGreaterThan(0);
  expect(new Set(wrappers)).toEqual(new Set(["contents"]));
}

async function expectPosterLoaded(page: Page): Promise<void> {
  await page.locator(POSTER_SELECTOR).first().scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (selector) => {
      const image = document.querySelector<HTMLImageElement>(selector);
      return image !== null && image.complete && image.naturalWidth > 0;
    },
    POSTER_SELECTOR,
    { timeout: POSTER_TIMEOUT_MS },
  );
}

async function expectOverview(session: RoleSession): Promise<void> {
  await expectPolicy(session, "/app");
  await expectLayoutWrapper(session.page);
  await main(session.page).locator('section[aria-label="Lesson of the week"]').waitFor();
  await main(session.page).locator('section[aria-label="Player card"]').waitFor();
  await expectHydrated(session.page);
  await expectPosterLoaded(session.page);
}

describe("csp: public pages", () => {
  const scenario = useScenario();

  test("the Snackday home, features and invite pages carry the Snackday policy and raise no violation", async () => {
    await asRole(scenario(), "signed-out", async (session) => {
      session.allowFailedResponse(404, "/api/invitations/preview");
      for (const path of ["/", "/features", "/invite#not-a-token"]) {
        await expectPolicy(session, path);
        await expectLayoutWrapper(session.page);
      }
    });
  });

  test("the dev sign-in page lists every role, hydrates, and raises no violation", async () => {
    await asRole(scenario(), "signed-out", async (session) => {
      await expectPolicy(session, DEV_SIGN_IN_PAGE_PATH);
      await expectHydrated(session.page);
      for (const persona of SEED_PERSONAS) {
        await session.page
          .locator(`button[data-persona="${persona.key}"]:not([disabled])`)
          .waitFor({ timeout: 5_000 });
      }
    });
  });

  test("the Ballplayer home and signed-out /app carry the Ballplayer policy and raise no violation", async () => {
    await asRole(
      scenario(),
      "signed-out",
      async (session) => {
        await expectPolicy(session, "/");
        await expectPolicy(session, "/app");
        await expectHydrated(session.page);
      },
      "ballplayer",
    );
  });
});

describe("csp: signed-in pages for every role", () => {
  const scenario = useScenario();
  const roles: readonly Role[] = [
    "head-coach",
    "co-coach",
    "parent",
    "second-team-guardian",
    "team-member",
    "stranger",
    "default",
    "second-adult",
  ];

  for (const role of roles) {
    test(`${role}: every app section carries the Snackday policy and raises no violation`, async () => {
      await asRole(scenario(), role, async (session) => {
        for (const section of APP_SECTIONS) {
          await expectPolicy(session, section.path);
          await expectLayoutWrapper(session.page);
          await expectNoSkeleton(session.page);
        }
      });
    });
  }

  test("head-coach: event detail, series edit, new event and a player card raise no violation", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      for (const path of [
        eventPath(OCCURRENCES.hawks),
        `/app/schedule/new?team=${SEED_TEAMS.coached.teamId}&season=${SEED_TEAMS.coached.seasonId}`,
        `/app/schedule/series/event_series_seed_falcons_hawks/edit?team=${SEED_TEAMS.coached.teamId}`,
        cardPath(CHILDREN.avery.participantId),
      ]) {
        await expectPolicy(session, path);
        await expectHydrated(session.page);
      }
    });
  });

  for (const role of ["parent", "head-coach", "co-coach"] as const) {
    test(`${role}: the Ballplayer /app cards carry the Ballplayer policy and raise no violation`, async () => {
      await asRole(
        scenario(),
        role,
        async (session) => {
          await expectPolicy(session, "/app");
          await session.page.getByRole("list", { name: "Player cards" }).waitFor();
        },
        "ballplayer",
      );
    });
  }
});

describe("csp: the lesson card and its poster", () => {
  const scenario = useScenario();

  test("parent: the overview loads the lesson poster from the media origin and an answer hydrates", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await expectOverview(session);
      const lesson = main(session.page).locator('section[aria-label="Lesson of the week"]');
      await lesson.locator('button[type="button"]').first().click();
      await lesson.locator('button[aria-pressed="true"]').first().waitFor({ timeout: 5_000 });
    });
  });

  test("head-coach: the overview loads the lesson poster and raises no violation", async () => {
    await asRole(scenario(), "head-coach", expectOverview);
  });

  test("head-coach and parent: the schedule and duties pages show the seeded events", async () => {
    for (const role of ["head-coach", "parent"] as const) {
      await asRole(scenario(), role, async (session) => {
        await expectPolicy(session, "/app/schedule");
        await expectLayoutWrapper(session.page);
        const schedule = await main(session.page).innerText();
        expect(schedule).toContain(SEED_SCHEDULE.gameTitles[0]);
        expect(schedule).toContain(SEED_SCHEDULE.practiceTitle);
        await expectPolicy(session, "/app/duties");
        await expectHydrated(session.page);
        const duties = await main(session.page).innerText();
        for (const label of SEED_SCHEDULE.gameDuties) expect(duties).toContain(label);
      });
    }
  });
});

describe(`csp: a ${LARGE_ROSTER_SIZE}-player roster streams past React's first chunk`, () => {
  const scenario = useScenario({ extraSql: largeRosterSql() });

  test("head-coach: the overview renders every player, leaves the skeleton and raises no violation", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await expectPolicy(session, "/app");
      await expectLayoutWrapper(session.page);
      await expectNoSkeleton(session.page);
      const routeBytes = await session.page.evaluate(
        () => document.querySelector("main")?.innerHTML.length ?? 0,
      );
      expect(routeBytes).toBeGreaterThan(REACT_PROGRESSIVE_CHUNK_SIZE);
      const roster = main(session.page).locator('section[aria-label="Roster"]');
      for (let index = 0; index < LARGE_ROSTER_SIZE; index += 1) {
        expect(await roster.getByText(largeRosterPlayer(index), { exact: true }).count()).toBe(1);
      }
      expect(
        await roster
          .getByText(largeRosterPlayer(LARGE_ROSTER_SIZE - 1))
          .first()
          .isVisible(),
      ).toBe(true);
    });
  });

  test("head-coach: the roster page renders every player and leaves the skeleton", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await expectPolicy(session, "/app/roster");
      await expectNoSkeleton(session.page);
      const players = main(session.page).getByRole("list", { name: "Players" });
      expect(await players.locator(":scope > li").count()).toBe(LARGE_ROSTER_SIZE + 3);
    });
  });
});
