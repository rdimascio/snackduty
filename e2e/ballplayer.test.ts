import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Page } from "playwright-core";

import { cardWriteRows, correctAnswer, lessonAnswersPath } from "./support/lessons";
import { CHILDREN, FALCONS, expectHtmlLacks, main, seededBirthDates } from "./support/pages";
import { useScenario } from "./support/scenario";
import { asRole, refused } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(90_000);

const READ_ONLY_LABEL =
  "Cards for players you coach are read only. Only a player's guardian can add to their card.";
const FALCONS_CHILDREN = [CHILDREN.avery, CHILDREN.blake, CHILDREN.casey] as const;

const SIGN_IN_BUTTONS = {
  parent: "Sign in as Pat Parent (guardian)",
  "head-coach": "Sign in as Hana Headcoach (head coach)",
  "co-coach": "Sign in as Cole Cocoach (co-coach)",
} as const;

type BallplayerRole = keyof typeof SIGN_IN_BUTTONS;

async function cardNames(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole("list", { name: "Player cards" })
    .locator('[aria-label^="Player card for "]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.replace("Player card for ", "")).toSorted();
}

async function bodyText(page: Page): Promise<string> {
  const text = await page.locator("body").evaluate((body) => {
    const copy = body.cloneNode(true) as HTMLElement;
    for (const script of copy.querySelectorAll("script, style")) script.remove();
    return copy.textContent ?? "";
  });
  return text.replaceAll(/\s+/gu, " ");
}

function skillCardPath(participantId: string): string {
  return `/api/teams/${FALCONS.teamId}/participants/${participantId}/skill-card`;
}

function devSkillEventsPath(participantId: string): string {
  return `/api/dev/teams/${FALCONS.teamId}/participants/${participantId}/skill-events`;
}

async function openApp(session: RoleSession) {
  const response = await session.open("/app");
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  await session.page.waitForLoadState("networkidle");
  return response;
}

function pathIs(url: string, path: string): boolean {
  return new URL(url).pathname === path;
}

async function signInFromPanel(session: RoleSession, role: BallplayerRole): Promise<void> {
  await openApp(session);
  expect(await bodyText(session.page)).toContain("Development sign-in");
  const choice = session.page.getByRole("button", { name: SIGN_IN_BUTTONS[role], exact: true });
  await session.page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === name && !candidate.disabled,
      ),
    SIGN_IN_BUTTONS[role],
  );
  const signedIn = session.page.waitForResponse((reply) => pathIs(reply.url(), "/api/dev/sign-in"));
  const reloaded = session.page.waitForResponse(
    (reply) => reply.request().isNavigationRequest() && pathIs(reply.url(), "/app"),
  );
  const signedInPageLoaded = session.page.waitForEvent("load");
  await choice.click();
  expect((await signedIn).status()).toBe(200);
  expect((await reloaded).status()).toBe(200);
  await signedInPageLoaded;
}

async function signOutFromApp(session: RoleSession): Promise<void> {
  const [cookie] = (await session.context.cookies()).filter((entry) =>
    entry.domain.includes("ballplayer.localhost"),
  );
  if (cookie === undefined) throw new Error("no Ballplayer session cookie");
  await Promise.all([
    session.page.waitForURL((url) => url.pathname === "/"),
    session.page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]);
  await openApp(session);
  expect(await bodyText(session.page)).toContain("Development sign-in");
  await session.context.addCookies([cookie]);
  await refused(session, "GET", "/api/session", undefined, [401]);
}

for (const role of ["head-coach", "co-coach"] as const) {
  describe(`ballplayer as coach (${role})`, () => {
    const scenario = useScenario();

    test("signs in from the /app panel, sees a read-only card for every rostered child, and signs out", async () => {
      await asRole(
        scenario(),
        "signed-out",
        async (session) => {
          await signInFromPanel(session, role);
          const response = await openApp(session);
          expect(response.status()).toBe(200);
          expect(await cardNames(session.page)).toEqual(
            FALCONS_CHILDREN.map((child) => child.displayName).toSorted(),
          );
          expect(await bodyText(session.page)).toContain(READ_ONLY_LABEL);
          await expectHtmlLacks(session.page, [
            CHILDREN.quinn.displayName,
            CHILDREN.jordan.displayName,
            ...seededBirthDates(scenario()),
          ]);
          await signOutFromApp(session);
        },
        "ballplayer",
      );
    });

    test("the coach view has no card write control", async () => {
      await asRole(
        scenario(),
        role,
        async (session) => {
          await openApp(session);
          const cards = session.page.getByRole("list", { name: "Player cards" });
          await cards.waitFor();
          expect(await cards.locator("form, input, textarea, select, button").count()).toBe(0);
          expect(
            await main(session.page).locator("form, input, textarea, select, button").count(),
          ).toBe(0);
        },
        "ballplayer",
      );
    });

    test("server refuses a coach's card write from the Ballplayer host on the lesson answer route and the dev skill-event route (404), and the card rows stay the same", async () => {
      const before = cardWriteRows(scenario(), CHILDREN.casey.participantId);
      await asRole(
        scenario(),
        role,
        async (session) => {
          const answered = await refused(
            session,
            "POST",
            lessonAnswersPath(FALCONS.teamId),
            correctAnswer(CHILDREN.casey.participantId),
            [404],
          );
          expect(answered.body).toEqual({ error: "participant not found" });
          await refused(
            session,
            "POST",
            devSkillEventsPath(CHILDREN.casey.participantId),
            { events: [] },
            [404],
          );
        },
        "ballplayer",
      );
      expect(cardWriteRows(scenario(), CHILDREN.casey.participantId)).toEqual(before);
    });
  });
}

describe("ballplayer as guardian of two (parent)", () => {
  const scenario = useScenario();

  test("signs in from the /app panel, sees only their two children's cards with no read-only label, and signs out", async () => {
    await asRole(
      scenario(),
      "signed-out",
      async (session) => {
        await signInFromPanel(session, "parent");
        await openApp(session);
        expect(await cardNames(session.page)).toEqual(
          [CHILDREN.avery.displayName, CHILDREN.blake.displayName].toSorted(),
        );
        const text = await bodyText(session.page);
        expect(text.includes(READ_ONLY_LABEL)).toBe(false);
        expect(text).toContain("Signed in as Pat Parent");
        await expectHtmlLacks(session.page, [
          CHILDREN.casey.displayName,
          ...seededBirthDates(scenario()),
        ]);
        await signOutFromApp(session);
      },
      "ballplayer",
    );
  });

  test("reads their own children's cards from the card API, and another family's child is refused (404): proves the card read guard", async () => {
    await asRole(
      scenario(),
      "parent",
      async (session) => {
        for (const own of [CHILDREN.avery, CHILDREN.blake]) {
          const reply = await session.api("GET", skillCardPath(own.participantId));
          expect(`${own.displayName}: ${reply.status}`).toBe(`${own.displayName}: 200`);
        }
        for (const other of [CHILDREN.casey, CHILDREN.quinn]) {
          const reply = await refused(
            session,
            "GET",
            skillCardPath(other.participantId),
            undefined,
            [404],
          );
          expect(reply.body).toEqual({ error: "participant not found" });
          expect(reply.text.includes(other.displayName)).toBe(false);
        }
      },
      "ballplayer",
    );
  });
});

const CARD_REFUSALS: readonly { role: Role; status: number; error: string }[] = [
  { role: "team-member", status: 404, error: "participant not found" },
  { role: "stranger", status: 404, error: "team not found" },
  { role: "signed-out", status: 401, error: "authentication required" },
];

for (const refusal of CARD_REFUSALS) {
  describe(`ballplayer card API as ${refusal.role}`, () => {
    const scenario = useScenario();

    test(`server refuses ${refusal.role} every card read and write (${refusal.status}), and the guardian's read and write on the same routes succeed: proves the card guards`, async () => {
      const before = cardWriteRows(scenario(), CHILDREN.avery.participantId);
      await asRole(
        scenario(),
        refusal.role,
        async (session) => {
          for (const child of FALCONS_CHILDREN) {
            const read = await refused(
              session,
              "GET",
              skillCardPath(child.participantId),
              undefined,
              [refusal.status],
            );
            expect(read.body).toEqual({ error: refusal.error });
          }
          const answered = await refused(
            session,
            "POST",
            lessonAnswersPath(FALCONS.teamId),
            correctAnswer(CHILDREN.avery.participantId),
            [refusal.status],
          );
          expect(answered.body).toEqual({ error: refusal.error });
          await refused(
            session,
            "POST",
            devSkillEventsPath(CHILDREN.avery.participantId),
            { events: [] },
            [refusal.status],
          );
        },
        "ballplayer",
      );
      expect(cardWriteRows(scenario(), CHILDREN.avery.participantId)).toEqual(before);

      await asRole(
        scenario(),
        "parent",
        async (session) => {
          expect(
            (await session.api("GET", skillCardPath(CHILDREN.avery.participantId))).status,
          ).toBe(200);
          const answered = await session.api(
            "POST",
            lessonAnswersPath(FALCONS.teamId),
            correctAnswer(CHILDREN.avery.participantId),
          );
          expect(answered.status).toBe(200);
        },
        "ballplayer",
      );
      expect(cardWriteRows(scenario(), CHILDREN.avery.participantId).answers).toHaveLength(
        before.answers.length + 1,
      );
    });
  });
}

describe("ballplayer as other roles", () => {
  const scenario = useScenario();

  test("the second-team guardian sees only Quinn's card", async () => {
    await asRole(
      scenario(),
      "second-team-guardian",
      async (session) => {
        await openApp(session);
        expect(await cardNames(session.page)).toEqual([CHILDREN.quinn.displayName]);
      },
      "ballplayer",
    );
  });

  for (const role of ["team-member", "stranger"] as const) {
    test(`${role} sees no card and no child name`, async () => {
      await asRole(
        scenario(),
        role,
        async (session) => {
          await openApp(session);
          expect(await bodyText(session.page)).toContain("No player cards yet");
          await expectHtmlLacks(
            session.page,
            Object.values(CHILDREN).map((child) => child.displayName),
          );
        },
        "ballplayer",
      );
    });
  }

  test("a signed-out visitor sees only the sign-in panel, and /dev/sign-in is a 404 on this host", async () => {
    await asRole(
      scenario(),
      "signed-out",
      async (session) => {
        await openApp(session);
        const text = await bodyText(session.page);
        for (const label of Object.values(SIGN_IN_BUTTONS)) expect(text).toContain(label);
        await expectHtmlLacks(
          session.page,
          Object.values(CHILDREN).map((child) => child.displayName),
        );
        await session.open("/dev/sign-in", 404);
        await session.open("/app/roster", 404);
      },
      "ballplayer",
    );
  });
});
