import { createApp } from "@lesto/kernel";
import { Context } from "@lesto/web";
import type { PageProps } from "@lesto/web";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { appServices } from "../app/lib/server/app-services";
import { DEV_PERSON_ID } from "../app/lib/server/identity";
import { invitationAcceptedBy, previewInvitation } from "../app/lib/server/invitations";
import invitePage from "../app/routes/invite/[token]/page";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("../lesto.app");

const app = await createApp(config);

// `lesto.app.ts` registers the live services on import — the same registry the
// page loader reads; the preview tests reach the typed Db through it.
const services = appServices();
if (services === undefined) throw new Error("lesto.app must register the app services.");
const db = services.db;

const TEAM_NAME = "Invite Landing Falcons";
// The inviter's own wording for the invitee — child-adjacent BY DESIGN, so the
// leak scans below prove it never reaches the accepting person's page.
const INVITEE_LABEL = "Maya's dad";
const CHILD_NAME = "Casey Kid";

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

async function createTeamSeasonAndChild(
  cookie: string,
): Promise<{ teamId: string; participantId: string }> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: TEAM_NAME },
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
  const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;

  const added = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
    headers: { ...sameOrigin, cookie },
    body: { displayName: CHILD_NAME, birthDate: "2018-04-09" },
  });
  expect(added.status).toBe(201);

  return {
    teamId,
    participantId: (json(added) as { participant: { participantId: string } }).participant
      .participantId,
  };
}

/** Creates a participant-bound invitation and returns its raw token + id. */
async function createInvitation(
  cookie: string,
  teamId: string,
  participantId: string,
): Promise<{ token: string; invitationId: string }> {
  const created = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: INVITEE_LABEL,
      participantId,
      relationship: "parent",
    },
  });
  expect(created.status).toBe(201);
  const invitation = (json(created) as { invitation: { id: string; inviteUrl?: string } })
    .invitation;
  const url = invitation.inviteUrl ?? "";
  expect(url.startsWith("/invite/")).toBe(true);
  return { token: url.slice("/invite/".length), invitationId: invitation.id };
}

async function acceptAs(cookie: string, token: string): Promise<void> {
  const accepted = await app.handle("POST", "/api/invitations/accept", {
    headers: { ...sameOrigin, cookie },
    body: { token },
  });
  expect(accepted.status).toBe(200);
}

/** A full pending invitation fixture: owner, team, child, invitation. */
async function seedInvitation(): Promise<{
  ownerCookie: string;
  teamId: string;
  token: string;
  invitationId: string;
}> {
  const ownerCookie = await signIn();
  const { teamId, participantId } = await createTeamSeasonAndChild(ownerCookie);
  const { token, invitationId } = await createInvitation(ownerCookie, teamId, participantId);
  return { ownerCookie, teamId, token, invitationId };
}

type Loaded = PageProps<NonNullable<typeof invitePage.load>>;

async function loadInvite(token: string, cookie?: string): Promise<Loaded> {
  const context = new Context<"/invite/:token">({
    method: "GET",
    path: `/invite/${token}`,
    params: { token },
    query: {},
    headers: cookie === undefined ? {} : { cookie },
    body: undefined,
  });
  // The page declares no `params` schema, so the loader's `search` argument is
  // unused; `null` stands in for "no validated search value".
  const loaded = await invitePage.load?.(context, null);
  if (loaded === undefined) throw new Error("The invite page must declare a server loader.");
  return loaded;
}

/** Static markup with React's `&#x27;` apostrophe escaping undone. */
function render(loaded: Loaded): string {
  return renderToStaticMarkup(<invitePage.component {...loaded} />).replaceAll("&#x27;", "'");
}

// The accepting person may only ever see team + inviter + role: never the
// invitee label ("Maya's dad" references a child), never the child, never an
// internal id. The token itself legitimately appears (it is the page's own
// URL segment, echoed into the Accept island's props).
function expectNoPrivateLeaks(html: string): void {
  const scanned = html.toLowerCase();
  for (const forbidden of ["maya", "casey", "person_", "participant_", "invitation_", "team_"]) {
    expect(scanned).not.toContain(forbidden);
  }
}

describe("previewInvitation", () => {
  it("returns exactly the delivery-payload fields for a pending invitation", async () => {
    const { token } = await seedInvitation();

    const preview = await previewInvitation(db, token);
    expect(preview).toEqual({
      teamName: TEAM_NAME,
      inviterDisplayName: "Development Adult",
      invitedRole: "adult",
    });
    // The privacy contract, asserted as an EXACT key set: even though this
    // invitation carries an invitee label AND a participant binding, neither —
    // nor any id — exists on the preview.
    expect(Object.keys(preview ?? {}).toSorted()).toEqual([
      "invitedRole",
      "inviterDisplayName",
      "teamName",
    ]);
  });

  it("returns undefined for an unknown token", async () => {
    await seedInvitation();
    expect(await previewInvitation(db, "not-a-real-token")).toBeUndefined();
  });

  it("returns undefined once the invitation is revoked", async () => {
    const { ownerCookie, teamId, token, invitationId } = await seedInvitation();
    const revoked = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${invitationId}/revoke`,
      { headers: { ...sameOrigin, cookie: ownerCookie } },
    );
    expect(revoked.status).toBe(200);

    expect(await previewInvitation(db, token)).toBeUndefined();
  });

  it("returns undefined once the invitation expires", async () => {
    const { token } = await seedInvitation();
    await config.db.exec("UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z'");

    expect(await previewInvitation(db, token)).toBeUndefined();
  });

  it("returns undefined once the invitation is accepted", async () => {
    const { token } = await seedInvitation();
    await acceptAs(await signIn("second-adult"), token);

    expect(await previewInvitation(db, token)).toBeUndefined();
  });
});

describe("invitationAcceptedBy", () => {
  it("resolves the team for the adult who accepted, and for no one else", async () => {
    const { token } = await seedInvitation();
    expect(await invitationAcceptedBy(db, token, DEV_PERSON_ID)).toBeUndefined();

    await acceptAs(await signIn("second-adult"), token);

    expect(await invitationAcceptedBy(db, token, "person_dev_second_adult")).toEqual({
      teamName: TEAM_NAME,
      grantedRole: "adult",
    });
    // A DIFFERENT adult — even the inviter — learns nothing from the token.
    expect(await invitationAcceptedBy(db, token, DEV_PERSON_ID)).toBeUndefined();
    expect(await invitationAcceptedBy(db, "not-a-real-token", DEV_PERSON_ID)).toBeUndefined();
  });
});

describe("/invite/:token page loader", () => {
  it("previews a valid invitation to a signed-out visitor with a sign-in affordance", async () => {
    const { token } = await seedInvitation();

    const loaded = await loadInvite(token);
    expect(loaded).toEqual({
      state: "preview",
      signedIn: false,
      teamName: TEAM_NAME,
      inviterDisplayName: "Development Adult",
      invitedRole: "adult",
      token,
    });

    const html = render(loaded);
    expect(html).toContain("You're invited");
    expect(html).toContain(TEAM_NAME);
    expect(html).toContain("Development Adult invited you to join as an adult member.");
    expect(html).toContain("Sign in to accept");
    expect(html).not.toContain("Accept invitation");
    expectNoPrivateLeaks(html);
  });

  it("previews with an Accept button for a signed-in adult", async () => {
    const { token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");

    const loaded = await loadInvite(token, memberCookie);
    expect(loaded.state).toBe("preview");
    expect(loaded).toMatchObject({ signedIn: true, teamName: TEAM_NAME });

    const html = render(loaded);
    expect(html).toContain(TEAM_NAME);
    expect(html).toContain("Accept invitation");
    expect(html).not.toContain("Sign in to accept");
    expectNoPrivateLeaks(html);
  });

  it("collapses unknown and revoked tokens into one indistinguishable invalid state", async () => {
    const { ownerCookie, teamId, token, invitationId } = await seedInvitation();

    const unknown = await loadInvite("not-a-real-token");
    expect(unknown).toEqual({ state: "invalid" });

    const revoked = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${invitationId}/revoke`,
      { headers: { ...sameOrigin, cookie: ownerCookie } },
    );
    expect(revoked.status).toBe(200);
    // Byte-identical loader results: a revoked link and a never-existing link
    // cannot be told apart from the page.
    expect(await loadInvite(token)).toEqual(unknown);

    const html = render(unknown);
    expect(html).toContain("This invite link isn't valid");
    expect(html).toContain("send a fresh link");
    expect(html).not.toContain(TEAM_NAME);
    expectNoPrivateLeaks(html);
  });

  it("shows the accepted invitation as invalid to a DIFFERENT signed-in adult", async () => {
    const { ownerCookie, token } = await seedInvitation();
    await acceptAs(await signIn("second-adult"), token);

    expect(await loadInvite(token, ownerCookie)).toEqual({ state: "invalid" });
    expect(await loadInvite(token)).toEqual({ state: "invalid" });
  });

  it("shows the success state to the adult who already accepted", async () => {
    const { token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);

    const loaded = await loadInvite(token, memberCookie);
    expect(loaded).toEqual({ state: "accepted", teamName: TEAM_NAME, grantedRole: "adult" });

    const html = render(loaded);
    expect(html).toContain(`You're on ${TEAM_NAME}`);
    expect(html).toContain("You joined as an adult member.");
    expect(html).toContain('href="/app"');
    expectNoPrivateLeaks(html);
  });

  it("renders the role the membership GRANTS after an upgrade, not the invitation's", async () => {
    const { ownerCookie, teamId, token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);

    const promotion = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
      headers: { ...sameOrigin, cookie: ownerCookie },
      body: { invitedRole: "owner", inviteeLabel: "promotion" },
    });
    expect(promotion.status).toBe(201);
    const promotionUrl =
      (json(promotion) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
    const ownerToken = promotionUrl.slice("/invite/".length);
    await acceptAs(memberCookie, ownerToken);

    // BOTH landing pages — the owner token's AND the older adult token's —
    // name the role in force, so the page can never outrun the grant.
    for (const accepted of [ownerToken, token]) {
      const loaded = await loadInvite(accepted, memberCookie);
      expect(loaded).toEqual({ state: "accepted", teamName: TEAM_NAME, grantedRole: "owner" });

      const html = render(loaded);
      expect(html).toContain(`You're on ${TEAM_NAME}`);
      expect(html).toContain("You joined as an owner.");
      expect(html).not.toContain("an adult member");
      expectNoPrivateLeaks(html);
    }
  });

  it("collapses the success state once the membership is revoked", async () => {
    const { token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);
    expect((await loadInvite(token, memberCookie)).state).toBe("accepted");

    await config.db.exec("UPDATE adult_memberships SET status = 'revoked'");

    // No membership is in force, so there is no role to name: the page shows
    // the one generic invalid state instead of claiming a lapsed grant.
    expect(await loadInvite(token, memberCookie)).toEqual({ state: "invalid" });
    expect(await invitationAcceptedBy(db, token, "person_dev_second_adult")).toBeUndefined();
  });

  it("renders the app-only fallback state for the service-less edge Worker", () => {
    const html = render({ state: "app-only" });
    expect(html).toContain("Open this link in the app");
    expect(html).toContain("Snackday app");
    expectNoPrivateLeaks(html);
  });
});
