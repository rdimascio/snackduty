import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { SEED_CHILDREN } from "../apps/web/app/dev/seed-personas";
import { useScenario } from "./support/scenario";
import { asRole } from "./support/session";

setDefaultTimeout(90_000);

const { avery, blake } = SEED_CHILDREN;

describe("account: erase a child", () => {
  const scenario = useScenario();

  test("a guardian erases one child from the account page and keeps the sibling", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await session.open("/app/account");
      const form = session.page.getByRole("form", { name: `Erase ${avery.displayName}` });
      await form.getByLabel(`Type ${avery.displayName} to confirm`).fill(avery.displayName);
      await form.getByRole("button", { name: `Erase ${avery.displayName}'s data` }).click();

      await form.waitFor({ state: "detached" });
      await session.page.getByRole("form", { name: `Erase ${blake.displayName}` }).waitFor();
    });

    const remaining = scenario().query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM participants WHERE id = ?",
      avery.participantId,
    );
    expect(remaining).toEqual([{ count: 0 }]);
  });

  test("a sole team owner is told why the account was not erased", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      session.allowFailedResponse(409, "/api/account/erase");
      await session.open("/app/account");
      const form = session.page.getByRole("form", { name: "Erase my account" });
      await form.getByLabel('Type "erase my account" to confirm').fill("erase my account");
      await form.getByRole("button", { name: "Erase my account" }).click();

      await form.getByText("you are the only owner of Scenario Falcons").waitFor();
    });
  });
});
