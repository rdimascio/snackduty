import { createApp } from "@lesto/kernel";
import { Context } from "@lesto/web";
import type { PageProps } from "@lesto/web";
import { renderToStaticMarkup as render } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import appPage from "../app/routes/app/page";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("../lesto.app");

const app = await createApp(config);

async function clearState() {
  // `lesto_rate_limits` is the kernel's shared per-client budget: the suite's
  // accumulated API calls would trip 429s here, which is the limiter working,
  // not the page — so reset it alongside the domain state.
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

async function createTeam(cookie: string): Promise<string> {
  const response = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "T-Ball Tigers" },
  });
  expect(response.status).toBe(201);
  return (json(response) as { team: { id: string } }).team.id;
}

async function createSeason(cookie: string, teamId: string): Promise<string> {
  const response = await app.handle("POST", `/api/teams/${teamId}/seasons`, {
    headers: { ...sameOrigin, cookie },
    body: {
      label: "Spring 2026",
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(response.status).toBe(201);
  return (json(response) as { season: { id: string } }).season.id;
}

async function addChild(
  cookie: string,
  teamId: string,
  seasonId: string,
  body?: { displayName: string; birthDate: string },
): Promise<string> {
  const response = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    {
      headers: { ...sameOrigin, cookie },
      body: body ?? { displayName: "Casey Kid", birthDate: "2018-04-09" },
    },
  );
  expect(response.status).toBe(201);
  return (json(response) as { participant: { participantId: string } }).participant.participantId;
}

async function attachGuardian(cookie: string, participantId: string, body: unknown): Promise<void> {
  const response = await app.handle("POST", `/api/participants/${participantId}/guardians`, {
    headers: { ...sameOrigin, cookie },
    body,
  });
  expect(response.status).toBe(201);
}

async function seedFullTeam(cookie: string): Promise<string> {
  const teamId = await createTeam(cookie);
  const seasonId = await createSeason(cookie, teamId);
  const participantId = await addChild(cookie, teamId, seasonId);
  await attachGuardian(cookie, participantId, {
    displayName: "Alex Guardian",
    relationship: "parent",
  });
  await attachGuardian(cookie, participantId, {
    displayName: "Bailey Guardian",
    relationship: "caregiver",
    permissions: ["participant.read"],
  });
  return teamId;
}

/** Joins `teamId` as the second persona through a real invitation accept. */
async function joinAsSecondAdult(
  ownerCookie: string,
  teamId: string,
  participantId?: string,
): Promise<string> {
  const memberCookie = await signIn("second-adult");
  const created = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie: ownerCookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: "joining adult",
      ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
    },
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    (json(created) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  // The token is in the FRAGMENT, so the request line is just `/invite`.
  expect(inviteUrl.startsWith("/invite#")).toBe(true);
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie: memberCookie },
    body: { token: inviteUrl.slice("/invite#".length) },
  });
  expect(accepted.status).toBe(200);
  return memberCookie;
}

type Loaded = PageProps<NonNullable<typeof appPage.load>>;

async function loadOverview(cookie?: string): Promise<Loaded> {
  const context = new Context<"/app">({
    method: "GET",
    path: "/app",
    params: {},
    query: {},
    headers: cookie === undefined ? {} : { cookie },
    body: undefined,
  });
  // The page declares no `params` schema, so the loader's `search` argument is
  // unused; `null` stands in for "no validated search value".
  const loaded = await appPage.load?.(context, null);
  if (loaded === undefined) throw new Error("The /app page must declare a server loader.");
  return loaded;
}

describe("/app overview loader", () => {
  it("renders the signed-in adult's real team, season, child, and guardians", async () => {
    const cookie = await signIn();
    await seedFullTeam(cookie);

    const loaded = await loadOverview(cookie);
    expect(loaded.state).toBe("team");

    const html = render(<appPage.component {...loaded} />);
    expect(html).toContain("T-Ball Tigers");
    expect(html).toContain("Spring 2026");
    expect(html).toContain("Casey Kid");
    expect(html).toContain("Born 2018-04-09");
    expect(html).toContain("Alex Guardian");
    expect(html).toContain("parent");
    expect(html).toContain("Bailey Guardian");
    expect(html).toContain("caregiver");
    expect(html).not.toContain("Signed out");
  });

  it("shows an adult member the team they joined by invitation", async () => {
    const ownerCookie = await signIn();
    const teamId = await seedFullTeam(ownerCookie);
    const memberCookie = await joinAsSecondAdult(ownerCookie, teamId);

    const loaded = await loadOverview(memberCookie);
    expect(loaded.state).toBe("team");

    const html = render(<appPage.component {...loaded} />);
    expect(html).toContain("T-Ball Tigers");
    expect(html).toContain("Spring 2026");
    expect(html).toContain("Casey Kid");
    expect(html).not.toContain("Born 2018-04-09");
    expect(html).not.toContain("Alex Guardian");
    expect(html).not.toContain("Bailey Guardian");
    expect(html).not.toContain("No guardians on file yet");
    expect(html).not.toContain("No team yet");
  });

  it("shows a guardian private fields for their own child only", async () => {
    const ownerCookie = await signIn();
    const teamId = await seedFullTeam(ownerCookie);
    const seasonId = (
      (await config.db.prepare("SELECT id FROM seasons WHERE team_id = ?").get([teamId])) as {
        id: string;
      }
    ).id;
    const caseyId = (
      (await config.db
        .prepare(
          "SELECT member_participant_id AS id FROM memberships WHERE team_id = ? AND season_id = ?",
        )
        .get([teamId, seasonId])) as { id: string }
    ).id;
    await addChild(ownerCookie, teamId, seasonId, {
      displayName: "Rowan Teammate",
      birthDate: "2019-05-14",
    });
    const guardianCookie = await joinAsSecondAdult(ownerCookie, teamId, caseyId);

    const html = render(<appPage.component {...await loadOverview(guardianCookie)} />);
    expect(html).toContain("Casey Kid");
    expect(html).toContain("Born 2018-04-09");
    expect(html).toContain("Second Development Adult");
    expect(html).toContain("Rowan Teammate");
    expect(html).not.toContain("Born 2019-05-14");
  });

  it("shows a child's guardian invitation counts without the inviter's label", async () => {
    const cookie = await signIn();
    const teamId = await seedFullTeam(cookie);
    const seasonId = (
      (await config.db.prepare("SELECT id FROM seasons WHERE team_id = ?").get([teamId])) as {
        id: string;
      }
    ).id;
    const participantId = (
      (await config.db
        .prepare(
          "SELECT member_participant_id AS id FROM memberships WHERE team_id = ? AND season_id = ?",
        )
        .get([teamId, seasonId])) as { id: string }
    ).id;

    const before = render(<appPage.component {...await loadOverview(cookie)} />);
    expect(before).not.toContain("Guardian invitations");

    const invited = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
      headers: { ...sameOrigin, cookie },
      body: {
        invitedRole: "adult",
        inviteeLabel: "Casey's dad",
        participantId,
        relationship: "parent",
      },
    });
    expect(invited.status).toBe(201);

    const html = render(<appPage.component {...await loadOverview(cookie)} />);
    expect(html).toContain("Guardian invitations");
    expect(html).toContain("1 invited");
    // The inviter's wording for the invitee quotes the child — it never renders.
    expect(html).not.toContain("dad");
  });

  it("resolves the signed-out state for unauthenticated and forged requests", async () => {
    const unauthenticated = await loadOverview();
    expect(unauthenticated).toEqual({ state: "signed-out" });

    const forged = await loadOverview("snackday_session_dev=forged-token");
    expect(forged).toEqual({ state: "signed-out" });

    const html = render(<appPage.component {...unauthenticated} />);
    expect(html).toContain("Signed out");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Roster");
  });

  it("renders honest empty states as the workspace fills in", async () => {
    const cookie = await signIn();
    expect(await loadOverview(cookie)).toEqual({ state: "no-team" });
    expect(render(<appPage.component {...await loadOverview(cookie)} />)).toContain("No team yet");

    const teamId = await createTeam(cookie);
    const withoutSeason = await loadOverview(cookie);
    expect(withoutSeason).toEqual({
      state: "team",
      teamName: "T-Ball Tigers",
      seasonLabel: undefined,
      roster: [],
    });
    const withoutSeasonHtml = render(<appPage.component {...withoutSeason} />);
    expect(withoutSeasonHtml).toContain("No season yet");
    expect(withoutSeasonHtml).toContain("No roster yet");

    await createSeason(cookie, teamId);
    const withoutChildren = await loadOverview(cookie);
    const withoutChildrenHtml = render(<appPage.component {...withoutChildren} />);
    expect(withoutChildrenHtml).toContain("Spring 2026");
    expect(withoutChildrenHtml).toContain("No roster yet");
  });

  it("keeps identity and credential material out of the rendered page", async () => {
    const cookie = await signIn();
    await seedFullTeam(cookie);

    const rendered = [
      render(<appPage.component {...await loadOverview(cookie)} />),
      render(<appPage.component {...await loadOverview()} />),
    ]
      .join("\n")
      .toLowerCase();

    for (const forbidden of [
      "email",
      "account",
      "cookie",
      "token",
      "person_id",
      "createdbypersonid",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});
