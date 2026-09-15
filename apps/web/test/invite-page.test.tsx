import { bindAppServices } from "../app/lib/server/app-services";
import { createApp } from "@lesto/kernel";
import { Context } from "@lesto/web";
import type { PageProps } from "@lesto/web";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEV_PERSON_ID,
  ensureDevelopmentPersona,
} from "../app/lib/server/identity";
import {
  createInvitationRecipientBinding,
  invitationAcceptedBy,
  previewInvitation,
} from "../app/lib/server/invitations";
import { createInvitationOutbox } from "../app/lib/server/invitation-outbox";
import invitePage from "../app/routes/invite/page";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config, services } =
  await import("./support/application").then((module) =>
    module.testApplication(),
  );

if (!Array.isArray(config.migrations))
  throw new Error("Invitation tests require migrations.");
const app = await createApp({
  ...config,
  migrations: [
    ...config.migrations,
    createInvitationRecipientBinding,
    createInvitationOutbox,
  ],
});

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
    "DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(
  response: { headers: Record<string, string | string[]> },
  name: string,
): string {
  const value = Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
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

  const createdSeason = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons`,
    {
      headers: { ...sameOrigin, cookie },
      body: {
        label: "Spring 2026",
        startDate: "2026-03-01",
        endDate: "2026-06-01",
        timeZone: "America/Los_Angeles",
      },
    },
  );
  expect(createdSeason.status).toBe(201);
  const seasonId = (json(createdSeason) as { season: { id: string } }).season
    .id;

  const added = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    {
      headers: { ...sameOrigin, cookie },
      body: { displayName: CHILD_NAME, birthDate: "2018-04-09" },
    },
  );
  expect(added.status).toBe(201);

  return {
    teamId,
    participantId: (json(added) as { participant: { participantId: string } })
      .participant.participantId,
  };
}

/**
 * The token out of a delivered link. It lives in the FRAGMENT — everything
 * before the `#` is the whole request line the server ever sees, and asserting
 * that here is the link-shape contract itself.
 */
function tokenOf(inviteUrl: string): string {
  const [path, ...fragment] = inviteUrl.split("#");
  expect(path).toBe("/invite");
  expect(fragment).toHaveLength(1);
  return fragment[0] ?? "";
}

/** Creates a participant-bound invitation and returns its raw token + id. */
async function createInvitation(
  cookie: string,
  teamId: string,
  participantId: string,
): Promise<{ token: string; invitationId: string }> {
  await ensureDevelopmentPersona(db, "second-adult");
  const created = await app.handle("POST", `/api/teams/${teamId}/invitations`, {
    headers: { ...sameOrigin, cookie },
    body: {
      invitedRole: "adult",
      inviteeLabel: INVITEE_LABEL,
      participantId,
      relationship: "parent",
      recipientBinding: {
        kind: "confirmed_person",
        personId: "person_dev_second_adult",
      },
    },
  });
  expect(created.status).toBe(201);
  const invitation = (
    json(created) as { invitation: { id: string; inviteUrl?: string } }
  ).invitation;
  return {
    token: tokenOf(invitation.inviteUrl ?? ""),
    invitationId: invitation.id,
  };
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
  const { token, invitationId } = await createInvitation(
    ownerCookie,
    teamId,
    participantId,
  );
  return { ownerCookie, teamId, token, invitationId };
}

type Loaded = PageProps<NonNullable<typeof invitePage.load>>;

async function loadInvite(cookie?: string): Promise<Loaded> {
  const context = new Context<"/invite">({
    method: "GET",
    path: "/invite",
    params: {},
    query: {},
    headers: cookie === undefined ? {} : { cookie },
    body: undefined,
  });
  bindAppServices(context, services);
  // The page declares no `params` schema, so the loader's `search` argument is
  // unused; `null` stands in for "no validated search value".
  const loaded = await invitePage.load?.(context, null);
  if (loaded === undefined)
    throw new Error("The invite page must declare a server loader.");
  return loaded;
}

/** Static markup with React's `&#x27;` apostrophe escaping undone. */
function render(loaded: Loaded): string {
  return renderToStaticMarkup(<invitePage.component {...loaded} />).replaceAll(
    "&#x27;",
    "'",
  );
}

/** `POST /api/invitations/preview` — the token in a BODY, never a request line. */
function previewOverHttp(token: string, cookie?: string) {
  return app.handle("POST", "/api/invitations/preview", {
    headers: { ...sameOrigin, ...(cookie === undefined ? {} : { cookie }) },
    body: { token },
  });
}

// The accepting person may only ever see team + inviter + role: never the
// invitee label ("Maya's dad" references a child), never the child, never an
// internal id. Applied to rendered markup AND to every preview response body.
function expectNoPrivateLeaks(text: string): void {
  const scanned = text.toLowerCase();
  for (const forbidden of [
    "maya",
    "casey",
    "person_",
    "participant_",
    "invitation_",
    "team_",
  ]) {
    expect(scanned).not.toContain(forbidden);
  }
}

describe("the invitation link shape", () => {
  it("does not offer the development sign-in endpoint from the shipped landing island", async () => {
    const source = await readFile(
      new URL("../app/islands/invite-landing.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("/api/dev/sign-in");
  });

  it("carries the token in the fragment, so the request line holds no credential", async () => {
    const { token } = await seedInvitation();

    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    // `tokenOf` already asserted the path is exactly `/invite`; this pins the
    // whole rule: nothing a server receives — path or query — carries it.
    const url = new URL(`https://snackday.test/invite#${token}`);
    expect(url.pathname).toBe("/invite");
    expect(url.search).toBe("");
    expect(`${url.pathname}${url.search}`).not.toContain(token);
  });
});

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
    await config.db.exec(
      "UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z'",
    );

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
    expect(
      await invitationAcceptedBy(db, token, DEV_PERSON_ID),
    ).toBeUndefined();

    await acceptAs(await signIn("second-adult"), token);

    expect(
      await invitationAcceptedBy(db, token, "person_dev_second_adult"),
    ).toEqual({
      teamName: TEAM_NAME,
      grantedRole: "adult",
    });
    // A DIFFERENT adult — even the inviter — learns nothing from the token.
    expect(
      await invitationAcceptedBy(db, token, DEV_PERSON_ID),
    ).toBeUndefined();
    expect(
      await invitationAcceptedBy(db, "not-a-real-token", DEV_PERSON_ID),
    ).toBeUndefined();
  });
});

describe("POST /api/invitations/preview", () => {
  it("previews a pending invitation to a SIGNED-OUT visitor", async () => {
    const { token } = await seedInvitation();

    const response = await previewOverHttp(token);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({
      state: "preview",
      teamName: TEAM_NAME,
      inviterDisplayName: "Development Adult",
      invitedRole: "adult",
    });
    // The privacy contract as an EXACT key set, on the wire this time: the
    // invitee label, the participant binding, and every id stay behind.
    expect(Object.keys(json(response) as object).toSorted()).toEqual([
      "invitedRole",
      "inviterDisplayName",
      "state",
      "teamName",
    ]);
    expectNoPrivateLeaks(response.body);
  });

  it("answers the accepted state to the adult who accepted, and hides it from everyone else", async () => {
    const { ownerCookie, token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);

    const mine = await previewOverHttp(token, memberCookie);
    expect(mine.status).toBe(200);
    expect(json(mine)).toEqual({
      state: "accepted",
      teamName: TEAM_NAME,
      grantedRole: "adult",
    });
    expect(Object.keys(json(mine) as object).toSorted()).toEqual([
      "grantedRole",
      "state",
      "teamName",
    ]);
    expectNoPrivateLeaks(mine.body);

    // A different adult — even the inviter — and a signed-out visitor get the
    // hiding 404: who accepted an invitation is never revealed.
    for (const cookie of [ownerCookie, undefined]) {
      const other = await previewOverHttp(token, cookie);
      expect(other.status).toBe(404);
      expect(json(other)).toEqual({ error: "invitation not found" });
    }
  });

  it("reports the role the MEMBERSHIP grants after an upgrade, not the invitation's", async () => {
    const { ownerCookie, teamId, token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);

    const promotion = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations`,
      {
        headers: { ...sameOrigin, cookie: ownerCookie },
        body: {
          invitedRole: "owner",
          inviteeLabel: "promotion",
          recipientBinding: {
            kind: "confirmed_person",
            personId: "person_dev_second_adult",
          },
        },
      },
    );
    expect(promotion.status).toBe(201);
    const ownerToken = tokenOf(
      (json(promotion) as { invitation: { inviteUrl?: string } }).invitation
        .inviteUrl ?? "",
    );
    await acceptAs(memberCookie, ownerToken);

    // BOTH tokens — the owner one AND the older adult one — name the role in
    // force, so the page can never outrun the grant.
    for (const accepted of [ownerToken, token]) {
      const response = await previewOverHttp(accepted, memberCookie);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual({
        state: "accepted",
        teamName: TEAM_NAME,
        grantedRole: "owner",
      });
    }
  });

  it("collapses the accepted state once the membership is revoked", async () => {
    const { token } = await seedInvitation();
    const memberCookie = await signIn("second-adult");
    await acceptAs(memberCookie, token);
    expect((await previewOverHttp(token, memberCookie)).status).toBe(200);

    await config.db.exec("UPDATE adult_memberships SET status = 'revoked'");

    // No membership is in force, so there is no role to name: the endpoint
    // answers its one hiding 404 rather than claiming a lapsed grant.
    const response = await previewOverHttp(token, memberCookie);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "invitation not found" });
  });

  it("answers ONE byte-identical response for unknown, revoked, expired, and someone-else's", async () => {
    const { ownerCookie, teamId, token, invitationId } = await seedInvitation();

    const unknown = await previewOverHttp("not-a-real-token");
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toEqual({ error: "invitation not found" });

    const revokedInvitation = await app.handle(
      "POST",
      `/api/teams/${teamId}/invitations/${invitationId}/revoke`,
      { headers: { ...sameOrigin, cookie: ownerCookie } },
    );
    expect(revokedInvitation.status).toBe(200);
    const revoked = await previewOverHttp(token);

    // A second fixture, expired rather than revoked, plus one accepted by a
    // DIFFERENT adult — every hidden reason answers the same bytes.
    const second = await seedInvitation();
    await config.db
      .prepare("UPDATE invitations SET expires_at = ? WHERE id = ?")
      .run(["2020-01-01T00:00:00.000Z", second.invitationId]);
    const expired = await previewOverHttp(second.token);

    const third = await seedInvitation();
    await acceptAs(await signIn("second-adult"), third.token);
    const someoneElses = await previewOverHttp(third.token, third.ownerCookie);

    for (const response of [revoked, expired, someoneElses]) {
      expect(response.status).toBe(unknown.status);
      expect(response.body).toBe(unknown.body);
    }
  });

  it("refuses a cross-site POST and validates the body at the boundary", async () => {
    const { token } = await seedInvitation();

    // Same zero-token CSRF as every other mutating route: the browser's
    // `Sec-Fetch-Site` is the whole check, so the island's same-origin fetch
    // passes and a cross-site form post never reaches the handler.
    const crossSite = await app.handle("POST", "/api/invitations/preview", {
      headers: { "sec-fetch-site": "cross-site" },
      body: { token },
    });
    expect(crossSite.status).toBe(403);

    // Boundary validation (ADR 0005) throws the coded `WEB_VALIDATION_FAILED`
    // that the HTTP layer answers 400 with — an empty token and an unknown key
    // both stop here rather than reaching a query.
    await expect(previewOverHttp("")).rejects.toThrow(
      "Request body failed validation.",
    );
    await expect(
      app.handle("POST", "/api/invitations/preview", {
        headers: sameOrigin,
        body: { token, teamId: "team_anything" },
      }),
    ).rejects.toThrow("Request body failed validation.");
  });
});

describe("/invite page loader", () => {
  it("resolves the app-only state for the service-less edge Worker", () => {
    // `appServices()` is registered in this process, so the edge branch is
    // exercised through the state it produces rather than by unregistering.
    const html = render({ state: "app-only" });
    expect(html).toContain("Open this link in the app");
    expect(html).toContain("Snackday app");
    expectNoPrivateLeaks(html);
  });

  it("reports no session for a signed-out visitor", async () => {
    await seedInvitation();

    expect(await loadInvite()).toEqual({
      state: "in-browser",
      signedIn: false,
    });
  });

  it("reports a session for a signed-in adult", async () => {
    await seedInvitation();
    const memberCookie = await signIn("second-adult");

    expect(await loadInvite(memberCookie)).toEqual({
      state: "in-browser",
      signedIn: true,
    });
  });

  it("renders no invitation data server-side — the fragment never reaches it", async () => {
    const { token } = await seedInvitation();

    const html = render(await loadInvite());
    // The loader never saw the token, so no state derived from it can be here.
    expect(html).not.toContain(token);
    expect(html).not.toContain(TEAM_NAME);
    expect(html).not.toContain("Development Adult");
    expect(html).not.toContain("Accept invitation");
    // What IS here: the calm resolving shell and an honest no-JavaScript note.
    expect(html).toContain("Checking your invitation");
    expect(html).toContain("needs JavaScript");
    expectNoPrivateLeaks(html);
  });
});
import { readFile } from "node:fs/promises";
