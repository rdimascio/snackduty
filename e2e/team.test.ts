import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Locator } from "playwright-core";

import { SEED_CALENDAR_FEED, SEED_INVITATIONS } from "../apps/web/app/dev/seed-personas";
import {
  COMETS,
  FALCONS,
  button,
  expectNoButton,
  localDatePlus,
  main,
  openFresh,
  persona,
  teamApi,
  waitForStatus,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import type { Scenario } from "./support/scenario";
import { asRole, refused } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(90_000);

const INVITEE = persona("default");
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const VERIFIED_INVITEE_EMAIL_SQL = [
  `INSERT INTO provider_identity_links (id, provider, issuer, subject, account_id, created_at, updated_at) VALUES ('provider_identity_link_e2e_default', 'apple', 'https://appleid.apple.com', 'e2e-default', '${INVITEE.accountId}', ${NOW}, ${NOW});`,
  `INSERT INTO verified_identity_emails (id, link_id, account_id, normalized_email, status, verified_at, updated_at) VALUES ('verified_identity_email_e2e_default', 'provider_identity_link_e2e_default', '${INVITEE.accountId}', '${INVITEE.email}', 'active', ${NOW}, ${NOW});`,
].join("\n");

function teamPage(teamId: string = FALCONS.teamId): string {
  return `/app/team?team=${teamId}`;
}

function section(session: RoleSession, id: string): Locator {
  return main(session.page).locator(`section[aria-labelledby="${id}"]`);
}

function membershipRole(scenario: Scenario, personId: string): string | undefined {
  return scenario.query<{ role: string }>(
    "SELECT role FROM adult_memberships WHERE team_id = ? AND person_id = ? AND status = 'active'",
    FALCONS.teamId,
    personId,
  )[0]?.role;
}

function invitationRow(
  scenario: Scenario,
  label: string,
): { id: string; status: string; token_hash: string } | undefined {
  return scenario.query<{ id: string; status: string; token_hash: string }>(
    "SELECT id, status, token_hash FROM invitations WHERE team_id = ? AND invitee_label = ?",
    FALCONS.teamId,
    label,
  )[0];
}

function activeFeeds(scenario: Scenario, teamId: string, personId: string): number {
  return scenario.query<{ id: string }>(
    "SELECT id FROM calendar_feed_tokens WHERE team_id = ? AND person_id = ? AND status = 'active'",
    teamId,
    personId,
  ).length;
}

async function feedStatus(session: RoleSession, url: string): Promise<number> {
  const path = new URL(url).pathname;
  session.allowFailedResponse(404, path);
  const reply = await session.api("GET", path);
  if (reply.status === 200) expect(reply.text).toContain("BEGIN:VCALENDAR");
  return reply.status;
}

async function newFeedLink(session: RoleSession, label: string): Promise<string> {
  const feed = section(session, "team-calendar");
  await feed.getByRole("button", { name: label, exact: true }).click();
  await waitForStatus(session.page, "Your new feed link is ready. Copy it now.");
  return feed.getByLabel("Calendar feed link").inputValue();
}

async function feedLifecycle(scenario: Scenario, session: RoleSession, teamId: string) {
  const personId = persona(session.role).personId;
  await openFresh(session, teamPage(teamId));
  const feed = section(session, "team-calendar");
  const startsActive = activeFeeds(scenario, teamId, personId) === 1;
  expect(await feed.getByRole("status").first().innerText()).toBe(
    startsActive
      ? "Your private feed link is active. Snackday shows a link only once, when you create it."
      : "You have no calendar feed for this team.",
  );

  const first = await newFeedLink(session, startsActive ? "Create a new link" : "Create feed link");
  await feed.getByRole("button", { name: "Copy link", exact: true }).click();
  await waitForStatus(session.page, "Link copied.");
  expect(await session.page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  expect(await feedStatus(session, first)).toBe(200);

  await openFresh(session, teamPage(teamId));
  expect(await section(session, "team-calendar").getByRole("status").first().innerText()).toContain(
    "Your private feed link is active.",
  );
  expect(activeFeeds(scenario, teamId, personId)).toBe(1);

  const rotated = await newFeedLink(session, "Create a new link");
  expect(rotated).not.toBe(first);
  expect(await feedStatus(session, first)).toBe(404);
  expect(await feedStatus(session, rotated)).toBe(200);
  expect(activeFeeds(scenario, teamId, personId)).toBe(1);

  await section(session, "team-calendar")
    .getByRole("button", { name: "Revoke feed", exact: true })
    .click();
  await waitForStatus(session.page, "You have no calendar feed for this team.");
  await openFresh(session, teamPage(teamId));
  expect(await section(session, "team-calendar").getByRole("status").first().innerText()).toBe(
    "You have no calendar feed for this team.",
  );
  expect(await feedStatus(session, rotated)).toBe(404);
  expect(activeFeeds(scenario, teamId, personId)).toBe(0);
}

async function refuseOwnerOnlyTeamWrites(session: RoleSession, statuses: readonly number[]) {
  const teamMember = persona("team-member").personId;
  await refused(
    session,
    "POST",
    teamApi(FALCONS.teamId, `/adult-members/${teamMember}/co-coach/grant`),
    undefined,
    statuses,
  );
  await refused(
    session,
    "POST",
    teamApi(FALCONS.teamId, `/adult-members/${persona("co-coach").personId}/co-coach/revoke`),
    undefined,
    statuses,
  );
  await refused(session, "GET", teamApi(FALCONS.teamId, "/invitations"), undefined, statuses);
  await refused(
    session,
    "POST",
    teamApi(FALCONS.teamId, "/invitations"),
    {
      invitedRole: "adult",
      inviteeLabel: "Refused invitee",
      recipientBinding: { kind: "verified_email", email: "refused@snackday.test" },
    },
    statuses,
  );
  await refused(
    session,
    "POST",
    teamApi(FALCONS.teamId, `/invitations/${SEED_INVITATIONS.caseyParent.id}/resend`),
    {},
    statuses,
  );
  await refused(
    session,
    "POST",
    teamApi(FALCONS.teamId, `/invitations/${SEED_INVITATIONS.caseyParent.id}/revoke`),
    undefined,
    statuses,
  );
}

async function createSeasonFromPage(scenario: Scenario, session: RoleSession, label: string) {
  await openFresh(session, teamPage());
  await button(session.page, "Create a season").click();
  const form = main(session.page).getByRole("form", { name: "Create a season" });
  await form.getByLabel("Season name").fill(label);
  await form.getByLabel("Start date").fill(localDatePlus(150));
  await form.getByLabel("End date").fill(localDatePlus(240));
  await form.getByLabel("Time zone").fill("America/Phoenix");
  await Promise.all([
    session.page.waitForURL(/season=/u),
    form.getByRole("button", { name: "Create season" }).click(),
  ]);
  const created = scenario.query<{ id: string }>(
    "SELECT id FROM seasons WHERE team_id = ? AND label = ?",
    FALCONS.teamId,
    label,
  );
  expect(created).toHaveLength(1);
  expect(new URL(session.page.url()).searchParams.get("season")).toBe(created[0]?.id ?? "");
  await openFresh(session, `${teamPage()}&season=${created[0]?.id ?? ""}`);
  const switcher = main(session.page).getByRole("navigation", { name: "Switch season" });
  expect(await switcher.locator('a[aria-current="page"]').innerText()).toBe(label);
  await switcher.getByText(FALCONS.seasonLabel).waitFor();
}

function feedRevokePath(teamId: string): string {
  return teamApi(teamId, "/calendar-feed/revoke");
}

async function refuseParentFeedRevoke(scenario: Scenario, role: Role, statuses: number[]) {
  const parent = persona("parent").personId;
  expect(activeFeeds(scenario, FALCONS.teamId, parent)).toBe(1);
  await asRole(scenario, role, async (session) => {
    await refused(session, "POST", feedRevokePath(FALCONS.teamId), undefined, statuses);
  });
  expect(activeFeeds(scenario, FALCONS.teamId, parent)).toBe(1);
  await asRole(scenario, "parent", async (session) => {
    const reply = await session.api("POST", feedRevokePath(FALCONS.teamId));
    expect(reply.status).toBe(200);
  });
  expect(activeFeeds(scenario, FALCONS.teamId, parent)).toBe(0);
}

function cometsInvitation(scenario: Scenario, label: string) {
  return scenario.query<{ id: string; status: string; token_hash: string }>(
    "SELECT id, status, token_hash FROM invitations WHERE team_id = ? AND invitee_label = ?",
    COMETS.teamId,
    label,
  )[0];
}

function cometsSeasons(scenario: Scenario, label: string): number {
  return scenario.query(
    "SELECT id FROM seasons WHERE team_id = ? AND label = ?",
    COMETS.teamId,
    label,
  ).length;
}

const SEASON_INPUT = {
  label: "Refused season",
  startDate: localDatePlus(30),
  endDate: localDatePlus(90),
  timeZone: "America/Phoenix",
};

describe("team as owner (head-coach)", () => {
  const scenario = useScenario({ extraSql: VERIFIED_INVITEE_EMAIL_SQL });
  const teamMember = persona("team-member");

  test("grants and revokes co-coach for an adult member, and a fresh load shows each change", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, teamPage());
      await button(session.page, `Make ${teamMember.displayName} a co-coach`).click();
      await waitForStatus(session.page, `${teamMember.displayName} is now a co-coach.`);
      expect(membershipRole(scenario(), teamMember.personId)).toBe("coach");

      await openFresh(session, teamPage());
      await expectNoButton(session.page, `Make ${teamMember.displayName} a co-coach`);
      await button(session.page, `Remove ${teamMember.displayName} as co-coach`).click();
      await waitForStatus(session.page, `${teamMember.displayName} is no longer a co-coach.`);
      expect(membershipRole(scenario(), teamMember.personId)).toBe("adult");

      await openFresh(session, teamPage());
      await button(session.page, `Make ${teamMember.displayName} a co-coach`).waitFor();
      await expectNoButton(session.page, `Remove ${teamMember.displayName} as co-coach`);
    });
  });

  test("the owner row has no role control and the server refuses to grant or revoke the owner's own role (409), while the owner's revoke of the co-coach succeeds: proves the owner guard", async () => {
    const owner = persona("head-coach").personId;
    const before = membershipRole(scenario(), owner);
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, teamPage());
      await expectNoButton(session.page, /Hana Headcoach/u);
      for (const change of ["grant", "revoke"]) {
        await refused(
          session,
          "POST",
          teamApi(FALCONS.teamId, `/adult-members/${owner}/co-coach/${change}`),
          undefined,
          [409],
        );
      }
      expect(membershipRole(scenario(), owner)).toBe(before);
      const control = await session.api(
        "POST",
        teamApi(FALCONS.teamId, `/adult-members/${persona("co-coach").personId}/co-coach/revoke`),
      );
      expect(control.status).toBe(200);
    });
    expect(membershipRole(scenario(), owner)).toBe(before);
    expect(membershipRole(scenario(), persona("co-coach").personId)).toBe("adult");
  });

  test("sends, resends and revokes an invitation, and a fresh load shows each change", async () => {
    const label = "E2E Resend Invitee";
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, teamPage());
      const form = main(session.page).getByRole("form", { name: "Send an invitation" });
      await form.getByLabel("Name").fill(label);
      await form.getByLabel("Email").fill("e2e-resend@snackday.test");
      await form.getByRole("button", { name: "Send invitation" }).click();
      await waitForStatus(session.page, `Invitation sent to ${label}.`);
      const firstLink = await main(session.page)
        .getByLabel("Invite link (development delivery)")
        .inputValue();
      const sent = invitationRow(scenario(), label);
      expect(sent?.status).toBe("pending");

      await openFresh(session, teamPage());
      const pending = main(session.page).getByRole("list", { name: "Pending invitations" });
      await pending.getByText(label, { exact: true }).waitFor();

      await button(session.page, `Resend invitation for ${label}`).click();
      await waitForStatus(
        session.page,
        `Invitation resent to ${label}. The old link no longer works.`,
      );
      const secondLink = await main(session.page)
        .getByLabel("Invite link (development delivery)")
        .inputValue();
      expect(secondLink).not.toBe(firstLink);
      const resent = invitationRow(scenario(), label);
      expect(resent?.status).toBe("pending");
      expect(resent?.token_hash).not.toBe(sent?.token_hash);

      await openFresh(session, teamPage());
      await button(session.page, `Revoke invitation for ${label}`).click();
      await waitForStatus(session.page, `Invitation for ${label} revoked.`);
      expect(invitationRow(scenario(), label)?.status).toBe("revoked");

      const text = await openFresh(session, teamPage());
      expect(text.includes(label)).toBe(false);
    });
  });

  test("an adult whose email is verified accepts the sent link and joins as an adult member", async () => {
    const label = "E2E Verified Invitee";
    let link = "";
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, teamPage());
      const form = main(session.page).getByRole("form", { name: "Send an invitation" });
      await form.getByLabel("Name").fill(label);
      await form.getByLabel("Email").fill(INVITEE.email);
      await form.getByRole("button", { name: "Send invitation" }).click();
      await waitForStatus(session.page, `Invitation sent to ${label}.`);
      link = await main(session.page).getByLabel("Invite link (development delivery)").inputValue();
    });
    const path = new URL(link);

    await asRole(scenario(), "team-member", async (session) => {
      await session.open(`${path.pathname}${path.search}${path.hash}`);
      session.allowFailedResponse(404, "/api/invitations/accept");
      const [accepted] = await Promise.all([
        session.page.waitForResponse(
          (reply) => new URL(reply.url()).pathname === "/api/invitations/accept",
        ),
        button(session.page, "Accept invitation").click(),
      ]);
      expect(accepted.status()).toBe(404);
      await refused(
        session,
        "POST",
        "/api/invitations/accept",
        { token: path.hash.slice(1) },
        [404],
      );
      expect(await main(session.page).getByText("Invitation accepted").count()).toBe(0);
      expect(invitationRow(scenario(), label)?.status).toBe("pending");
    });

    await asRole(scenario(), "default", async (session) => {
      await session.open(`${path.pathname}${path.search}${path.hash}`);
      await button(session.page, "Accept invitation").click();
      await main(session.page).getByText("Invitation accepted").waitFor();
      const text = await openFresh(session, teamPage());
      expect(text).toContain(FALCONS.name);
      expect(text).toContain("Adult member");
    });
    expect(invitationRow(scenario(), label)?.status).toBe("accepted");
    expect(membershipRole(scenario(), INVITEE.personId)).toBe("adult");
  });

  test("calendar feed: creates, copies, rotates and revokes the owner's own link", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      feedLifecycle(scenario(), session, FALCONS.teamId),
    );
  });

  test("creates a season, and a fresh load selects it and lists both seasons", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      createSeasonFromPage(scenario(), session, "E2E Spring"),
    );
  });
});

describe("team as co-coach (co-coach)", () => {
  const scenario = useScenario();

  test("sees seasons and members with no co-coach or invitation controls", async () => {
    await asRole(scenario(), "co-coach", async (session) => {
      const text = await openFresh(session, teamPage());
      expect(text).toContain("Co-coach");
      await button(session.page, "Create a season").waitFor();
      await expectNoButton(session.page, /a co-coach$/u);
      await expectNoButton(session.page, /as co-coach$/u);
      await expectNoButton(session.page, "Send invitation");
      expect(await section(session, "team-invitations").count()).toBe(0);
    });
  });

  test("server refuses co-coach grant and revoke and every invitation call to a co-coach (404): proves the owner-only guard", async () => {
    await asRole(scenario(), "co-coach", async (session) => {
      await refuseOwnerOnlyTeamWrites(session, [404]);
    });
    expect(membershipRole(scenario(), persona("team-member").personId)).toBe("adult");
    expect(invitationRow(scenario(), "Casey's parent")?.status).toBe("pending");
  });

  test("calendar feed: creates, copies, rotates and revokes the co-coach's own link", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      feedLifecycle(scenario(), session, FALCONS.teamId),
    );
  });

  test("creates a season, and a fresh load selects it and lists both seasons", async () => {
    await asRole(scenario(), "co-coach", (session) =>
      createSeasonFromPage(scenario(), session, "E2E Cocoach Spring"),
    );
  });
});

describe("team as guardian of two (parent)", () => {
  const scenario = useScenario();

  test("sees no season, co-coach or invitation controls", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await openFresh(session, teamPage());
      await expectNoButton(session.page, "Create a season");
      await expectNoButton(session.page, /co-coach/u);
      await expectNoButton(session.page, "Send invitation");
    });
  });

  test("server refuses a season create (404) and every owner-only call to a guardian: proves the manage guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await refused(session, "POST", teamApi(FALCONS.teamId, "/seasons"), SEASON_INPUT, [404]);
      await refuseOwnerOnlyTeamWrites(session, [404]);
    });
    expect(
      scenario().query("SELECT id FROM seasons WHERE label = ?", SEASON_INPUT.label),
    ).toHaveLength(0);
  });

  test("calendar feed: rotates the seeded link, copies it and revokes it", async () => {
    expect(activeFeeds(scenario(), SEED_CALENDAR_FEED.teamId, persona("parent").personId)).toBe(1);
    await asRole(scenario(), "parent", (session) =>
      feedLifecycle(scenario(), session, FALCONS.teamId),
    );
  });
});

describe("team as second-team guardian (second-team-guardian)", () => {
  const scenario = useScenario();

  test("server refuses every Falcons team call to a Comets-only guardian (404): proves the team membership guard", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId), undefined, [404]);
      await refused(session, "POST", teamApi(FALCONS.teamId, "/calendar-feed"), undefined, [404]);
      await refused(session, "POST", teamApi(FALCONS.teamId, "/seasons"), SEASON_INPUT, [404]);
      await refuseOwnerOnlyTeamWrites(session, [404]);
    });
    expect(activeFeeds(scenario(), FALCONS.teamId, persona("second-team-guardian").personId)).toBe(
      0,
    );
  });

  test("calendar feed: creates, copies, rotates and revokes a Comets link", async () => {
    await asRole(scenario(), "second-team-guardian", (session) =>
      feedLifecycle(scenario(), session, COMETS.teamId),
    );
  });
});

describe("team as second-team guardian on the Comets (second-team-guardian)", () => {
  const scenario = useScenario();
  const label = "E2E Comets Invitee";
  const seasonLabel = "E2E Comets Spring";
  const invitations = teamApi(COMETS.teamId, "/invitations");
  const season = { ...SEASON_INPUT, label: seasonLabel };

  test("server refuses a Comets season create and every Comets invitation call to a guardian (404), and the Comets owner's same calls succeed: proves the manage and owner guards", async () => {
    await asRole(scenario(), "default", async (session) => {
      const sent = await session.api("POST", invitations, {
        invitedRole: "adult",
        inviteeLabel: label,
        recipientBinding: { kind: "verified_email", email: "e2e-comets@snackday.test" },
      });
      expect(sent.status).toBe(201);
    });
    const invitation = cometsInvitation(scenario(), label);
    if (invitation === undefined) throw new Error("the Comets owner sent no invitation");

    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(session, "POST", teamApi(COMETS.teamId, "/seasons"), season, [404]);
      await refused(session, "GET", invitations, undefined, [404]);
      await refused(
        session,
        "POST",
        invitations,
        {
          invitedRole: "adult",
          inviteeLabel: "Refused Comets invitee",
          recipientBinding: { kind: "verified_email", email: "refused-comets@snackday.test" },
        },
        [404],
      );
      await refused(session, "POST", `${invitations}/${invitation.id}/resend`, {}, [404]);
      await refused(session, "POST", `${invitations}/${invitation.id}/revoke`, undefined, [404]);
    });
    expect(cometsSeasons(scenario(), seasonLabel)).toBe(0);
    expect(cometsInvitation(scenario(), "Refused Comets invitee")).toBeUndefined();
    expect(cometsInvitation(scenario(), label)).toEqual(invitation);

    await asRole(scenario(), "default", async (session) => {
      expect((await session.api("POST", teamApi(COMETS.teamId, "/seasons"), season)).status).toBe(
        201,
      );
      const listed = await session.api("GET", invitations);
      expect(listed.status).toBe(200);
      expect(listed.text).toContain(label);
      const resent = await session.api("POST", `${invitations}/${invitation.id}/resend`, {});
      expect(resent.status).toBe(200);
      expect(cometsInvitation(scenario(), label)?.token_hash).not.toBe(invitation.token_hash);
      const revoked = await session.api("POST", `${invitations}/${invitation.id}/revoke`);
      expect(revoked.status).toBe(200);
    });
    expect(cometsSeasons(scenario(), seasonLabel)).toBe(1);
    expect(cometsInvitation(scenario(), label)?.status).toBe("revoked");
  });
});

describe("team as adult member (team-member)", () => {
  const scenario = useScenario();

  test("sees the member list with no controls", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      const text = await openFresh(session, teamPage());
      expect(text).toContain("Max Member (you)");
      await expectNoButton(session.page, "Create a season");
      await expectNoButton(session.page, /co-coach/u);
      await expectNoButton(session.page, "Send invitation");
    });
  });

  test("server refuses to let an adult member make themself co-coach (404): proves the delegate guard", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      await refused(session, "POST", teamApi(FALCONS.teamId, "/seasons"), SEASON_INPUT, [404]);
      await refuseOwnerOnlyTeamWrites(session, [404]);
    });
    expect(membershipRole(scenario(), persona("team-member").personId)).toBe("adult");
  });

  test("calendar feed: creates, copies, rotates and revokes the member's own link", async () => {
    await asRole(scenario(), "team-member", (session) =>
      feedLifecycle(scenario(), session, FALCONS.teamId),
    );
  });
});

describe("team as stranger (stranger)", () => {
  const scenario = useScenario();

  test("server refuses Falcons reads and a Falcons feed to a stranger (404): proves the team membership guard", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId), undefined, [404]);
      await refused(session, "POST", teamApi(FALCONS.teamId, "/calendar-feed"), undefined, [404]);
      await refuseOwnerOnlyTeamWrites(session, [404]);
    });
  });

  test("server refuses a Falcons feed revoke to a stranger (404), and the parent's own revoke on the same route succeeds: proves the team membership guard", async () => {
    await refuseParentFeedRevoke(scenario(), "stranger", [404]);
  });

  test("a stranger with a seeded token cannot redeem a different adult's invitation (404)", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await refused(
        session,
        "POST",
        "/api/invitations/accept",
        { token: SEED_INVITATIONS.caseyParent.token },
        [404],
      );
    });
    expect(invitationRow(scenario(), "Casey's parent")?.status).toBe("pending");
  });

  test("accepts the pending invitation and a fresh load shows the Falcons team", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await session.open(`/invite#${SEED_INVITATIONS.stranger.token}`);
      await button(session.page, "Accept invitation").click();
      await main(session.page).getByText("Invitation accepted").waitFor();
      const text = await openFresh(session, teamPage());
      expect(text).toContain(FALCONS.name);
      expect(text).toContain("Sid Stranger (you)");
    });
    expect(membershipRole(scenario(), persona("stranger").personId)).toBe("adult");
  });
});

describe("team as signed-out visitor", () => {
  const scenario = useScenario();
  const signedOut: Role = "signed-out";

  test("server answers 401 to every team call without a session", async () => {
    await asRole(scenario(), signedOut, async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId), undefined, [401]);
      await refused(session, "POST", teamApi(FALCONS.teamId, "/calendar-feed"), undefined, [401]);
      await refused(session, "POST", teamApi(FALCONS.teamId, "/seasons"), SEASON_INPUT, [401]);
      await refuseOwnerOnlyTeamWrites(session, [401]);
      await refused(
        session,
        "POST",
        "/api/invitations/accept",
        { token: SEED_INVITATIONS.stranger.token },
        [401],
      );
    });
  });

  test("server answers 401 to a feed revoke without a session, and the parent's own revoke on the same route succeeds: proves the session guard", async () => {
    await refuseParentFeedRevoke(scenario(), signedOut, [401]);
  });
});
