import { createApp } from "@lesto/kernel";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config } = await import("../lesto.app");

const app = await createApp(config);

async function clearState() {
  await config.db.exec(
    "DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
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
const FEED_URL_SHAPE = /^\/calendar\/feed\/[0-9a-f]{64}$/u;

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

interface Fixture {
  teamId: string;
  seasonId: string;
  childId: string;
  occurrenceIds: string[];
}

/**
 * A team with a rostered child, recorded attendance, and the DST-crossing
 * weekly practice — everything a leaked feed must NOT reveal beyond the
 * schedule itself.
 */
async function buildFixture(cookie: string): Promise<Fixture> {
  const createdTeam = await app.handle("POST", "/api/teams", {
    headers: { ...sameOrigin, cookie },
    body: { name: "Feed Falcons" },
  });
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
  const seasonId = (json(createdSeason) as { season: { id: string } }).season.id;

  const addedChild = await app.handle(
    "POST",
    `/api/teams/${teamId}/seasons/${seasonId}/participants`,
    {
      headers: { ...sameOrigin, cookie },
      body: { displayName: "Casey Kid", birthDate: "2018-04-09" },
    },
  );
  const childId = (json(addedChild) as { participant: { participantId: string } }).participant
    .participantId;

  const createdEvent = await app.handle("POST", `/api/teams/${teamId}/seasons/${seasonId}/events`, {
    headers: { ...sameOrigin, cookie },
    body: {
      title: "Tuesday Practice",
      kind: "practice",
      location: "Riverside Park, Field 2",
      notes: "Bring water",
      schedule: {
        timeZone: "America/Los_Angeles",
        localTime: "17:00",
        durationMinutes: 60,
        frequency: "weekly",
        byWeekday: ["tuesday"],
        startDate: "2026-03-03",
        untilDate: "2026-03-17",
      },
    },
  });
  expect(createdEvent.status).toBe(201);
  const occurrenceIds = (json(createdEvent) as { occurrences: { id: string }[] }).occurrences.map(
    (occurrence) => occurrence.id,
  );

  const recorded = await app.handle(
    "POST",
    `/api/teams/${teamId}/occurrences/${occurrenceIds[0]}/attendance`,
    { headers: { ...sameOrigin, cookie }, body: { participantId: childId, status: "yes" } },
  );
  expect(recorded.status).toBe(200);

  return { teamId, seasonId, childId, occurrenceIds };
}

async function mintFeed(cookie: string, teamId: string) {
  return app.handle("POST", `/api/teams/${teamId}/calendar-feed`, {
    headers: { ...sameOrigin, cookie },
  });
}

function feedUrlOf(response: { body: string }): string {
  const url = (json(response) as { feed: { url: string } }).feed.url;
  expect(url).toMatch(FEED_URL_SHAPE);
  return url;
}

function fetchFeed(url: string) {
  // A calendar client's poll: plain GET, no cookie, no fetch metadata.
  return app.handle("GET", url, {});
}

describe("minting and rotating the feed", () => {
  it("mints a per-adult hash-only token whose URL reveals nothing else", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);

    const minted = await mintFeed(cookie, fixture.teamId);
    expect(minted.status).toBe(201);
    const url = feedUrlOf(minted);
    const rawToken = url.split("/").at(-1) ?? "";
    expect(url).not.toContain(fixture.teamId);

    const rows = (await config.db
      .prepare("SELECT token_hash, status FROM calendar_feed_tokens")
      .all()) as { token_hash: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    // HASH-ONLY storage: the stored value is 64 hex and is NOT the token.
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]?.token_hash).not.toBe(rawToken);
  });

  it("rotates on re-mint: the old URL dies, indistinguishable from unknown", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);

    const first = await mintFeed(cookie, fixture.teamId);
    expect(first.status).toBe(201);
    const firstUrl = feedUrlOf(first);
    expect((await fetchFeed(firstUrl)).status).toBe(200);

    const second = await mintFeed(cookie, fixture.teamId);
    expect(second.status).toBe(200);
    const secondUrl = feedUrlOf(second);
    expect(secondUrl).not.toBe(firstUrl);

    const dead = await fetchFeed(firstUrl);
    const unknown = await fetchFeed(`/calendar/feed/${"0".repeat(64)}`);
    expect(dead.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(dead.body).toBe(unknown.body);

    expect((await fetchFeed(secondUrl)).status).toBe(200);
    // Still exactly one row per adult per team.
    expect(await config.db.prepare("SELECT id FROM calendar_feed_tokens").all()).toHaveLength(1);
  });

  it("revoke kills the feed outright; a later mint starts fresh", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);
    const url = feedUrlOf(await mintFeed(cookie, fixture.teamId));

    const revoked = await app.handle("POST", `/api/teams/${fixture.teamId}/calendar-feed/revoke`, {
      headers: { ...sameOrigin, cookie },
    });
    expect(revoked.status).toBe(200);
    expect(json(revoked)).toEqual({ feed: { status: "revoked" } });

    const dead = await fetchFeed(url);
    const unknown = await fetchFeed(`/calendar/feed/${"0".repeat(64)}`);
    expect(dead.status).toBe(404);
    expect(dead.body).toBe(unknown.body);

    // Revoking again stays calm.
    expect(
      (
        await app.handle("POST", `/api/teams/${fixture.teamId}/calendar-feed/revoke`, {
          headers: { ...sameOrigin, cookie },
        })
      ).status,
    ).toBe(200);

    const reminted = await mintFeed(cookie, fixture.teamId);
    expect(reminted.status).toBe(201);
    expect((await fetchFeed(feedUrlOf(reminted))).status).toBe(200);
  });

  it("hides minting from strangers and requires authentication", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);

    expect((await mintFeed("", fixture.teamId)).status).toBe(401);

    const strangerCookie = await signIn("second-adult");
    const hidden = await mintFeed(strangerCookie, fixture.teamId);
    expect(hidden.status).toBe(404);
    expect(json(hidden)).toEqual({ error: "team not found" });
    expect(await config.db.prepare("SELECT id FROM calendar_feed_tokens").all()).toEqual([]);
  });
});

describe("the feed body", () => {
  it("serves the schedule — and NOTHING about the roster — as valid ICS", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);
    const url = feedUrlOf(await mintFeed(cookie, fixture.teamId));

    const served = await fetchFeed(url);
    expect(served.status).toBe(200);
    expect(header(served, "content-type")).toBe("text/calendar; charset=utf-8");
    expect(header(served, "x-robots-tag")).toBe("noindex, nofollow");
    expect(header(served, "cache-control")).toBe("private, no-store");

    const body = served.body;
    expect(body).toContain("X-WR-CALNAME:Feed Falcons (Snackday)");
    expect(body).toContain("SUMMARY:Tuesday Practice");
    expect(body).toContain("LOCATION:Riverside Park\\, Field 2");
    expect(body).toContain("DESCRIPTION:Bring water");
    // The DST pair: 17:00 local on both sides of 2026-03-08.
    expect(body).toContain("DTSTART:20260304T010000Z");
    expect(body).toContain("DTSTART:20260311T000000Z");

    // CRLF-only, folded to 75 octets.
    expect(body.endsWith("\r\n")).toBe(true);
    const encoder = new TextEncoder();
    for (const line of body.slice(0, -2).split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
      expect(line).not.toContain("\n");
    }

    // THE point of the design: a leaked feed exposes a schedule, not a roster
    // of minors. No child name, no attendance, no guardian, no person id.
    const scanned = body.toLowerCase();
    for (const forbidden of [
      "casey",
      "kid",
      "participant",
      "person_",
      "guardian",
      "attendance",
      "2018-04-09",
    ]) {
      expect(scanned).not.toContain(forbidden);
    }
  });

  it("keeps cancelled occurrences visible as STATUS:CANCELLED", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);
    const url = feedUrlOf(await mintFeed(cookie, fixture.teamId));

    const cancelled = await app.handle(
      "POST",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceIds[1]}/cancel`,
      { headers: { ...sameOrigin, cookie }, body: { reason: "Field flooded" } },
    );
    expect(cancelled.status).toBe(200);

    const body = (await fetchFeed(url)).body;
    expect(body.match(/STATUS:CANCELLED/gu)).toHaveLength(1);
    expect(body.match(/STATUS:CONFIRMED/gu)).toHaveLength(2);
    expect(body.match(/BEGIN:VEVENT/gu)).toHaveLength(3);
    // The manager's stated reason stays inside the team surface, not the feed.
    expect(body).not.toContain("Field flooded");
  });

  it("dies with the adult's team access", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);

    // A read-only member mints their own feed through the real invite flow.
    const invited = await app.handle("POST", `/api/teams/${fixture.teamId}/invitations`, {
      headers: { ...sameOrigin, cookie: ownerCookie },
      body: { invitedRole: "adult", inviteeLabel: "the second adult" },
    });
    const token = (
      json(invited) as { invitation: { inviteUrl: string } }
    ).invitation.inviteUrl.split("#")[1];
    const memberCookie = await signIn("second-adult");
    const accepted = await app.handle("POST", "/api/invitations/accept", {
      headers: { ...sameOrigin, cookie: memberCookie },
      body: { token },
    });
    expect(accepted.status).toBe(200);

    const minted = await mintFeed(memberCookie, fixture.teamId);
    expect(minted.status).toBe(201);
    const url = feedUrlOf(minted);
    expect((await fetchFeed(url)).status).toBe(200);

    // Their membership is revoked — the feed URL must die with it.
    await config.db
      .prepare("UPDATE adult_memberships SET status = 'revoked' WHERE person_id = ?")
      .run(["person_dev_second_adult"]);

    const dead = await fetchFeed(url);
    const unknown = await fetchFeed(`/calendar/feed/${"0".repeat(64)}`);
    expect(dead.status).toBe(404);
    expect(dead.body).toBe(unknown.body);
  });
});

describe("single-event export", () => {
  it("is an authenticated child-free download", async () => {
    const cookie = await signIn();
    const fixture = await buildFixture(cookie);

    const exported = await app.handle(
      "GET",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceIds[0]}/export`,
      { headers: { cookie } },
    );
    expect(exported.status).toBe(200);
    expect(header(exported, "content-type")).toBe("text/calendar; charset=utf-8");
    expect(header(exported, "content-disposition")).toBe(
      'attachment; filename="snackday-event.ics"',
    );
    expect(exported.body.match(/BEGIN:VEVENT/gu)).toHaveLength(1);
    expect(exported.body).toContain("SUMMARY:Tuesday Practice");
    expect(exported.body).toContain("DTSTART:20260304T010000Z");
    for (const forbidden of ["casey", "participant", "person_", "guardian"]) {
      expect(exported.body.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("requires a session and hides foreign or unknown targets", async () => {
    const ownerCookie = await signIn();
    const fixture = await buildFixture(ownerCookie);

    const signedOut = await app.handle(
      "GET",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceIds[0]}/export`,
      {},
    );
    expect(signedOut.status).toBe(401);

    const strangerCookie = await signIn("second-adult");
    const hidden = await app.handle(
      "GET",
      `/api/teams/${fixture.teamId}/occurrences/${fixture.occurrenceIds[0]}/export`,
      { headers: { cookie: strangerCookie } },
    );
    expect(hidden.status).toBe(404);
    expect(json(hidden)).toEqual({ error: "team not found" });

    const unknown = await app.handle(
      "GET",
      `/api/teams/${fixture.teamId}/occurrences/event_occurrence_missing/export`,
      { headers: { cookie: ownerCookie } },
    );
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toEqual({ error: "event not found" });
  });
});
