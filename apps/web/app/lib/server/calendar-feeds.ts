import type { Clock } from "./application-contracts";
/**
 * Private calendar feeds and ICS export (ADR 0009).
 *
 * THE DOCUMENTED COLLISION: Snackday's rule is that a bearer credential never
 * appears in the request line of a URL — invitation links ride the fragment.
 * A calendar SUBSCRIPTION cannot honor that: Apple Calendar and Google
 * Calendar poll a plain GET URL with no fragment, no header, no body. So this
 * one credential lives in a path, and everything around it narrows the blast
 * radius:
 *
 *   - Per-adult, per-team, random 256 bits, stored HASH-ONLY (bearer-tokens
 *     .ts). Minting again ROTATES — the old URL dies; revoke kills the feed
 *     outright. A feed whose adult has lost team access stops answering.
 *   - `/calendar/feed/:token` is a registered redaction shape in access-log.ts
 *     — but that seam is INERT for this route today, so our own logs DO hold
 *     live feed credentials. It is installed only in worker.ts (the edge
 *     handler), which serves four pages and no database and therefore never
 *     sees this route; the node tier that does serve it has no logging seam to
 *     install it in, so `lesto dev` and `lesto serve` write the whole path,
 *     token included. Exposure today is developer terminals and the acceptance
 *     harness; it becomes live the moment Snackday is served from the node
 *     tier. ADR 0009 carries the full record and the trigger.
 *   - The body is DELIBERATELY CHILD-FREE: team name, event title, time,
 *     location, notes, cancellation state. Never a child's name, never
 *     attendance, never guardian data — a leaked feed URL exposes a practice
 *     schedule, not a roster of minors.
 *   - Responses are `X-Robots-Tag: noindex`; the URL derives from nothing but
 *     the random token.
 *   - Every failure — unknown, revoked, rotated-away, team gone, access
 *     revoked — is ONE byte-identical hiding 404.
 *
 * The single-event export is different on purpose: it is an AUTHENTICATED
 * download (session cookie, readable team), not a pollable URL, and equally
 * child-free.
 */

import type { SessionService as Sessions } from "./application-contracts";
import { and, createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import type { Context, Lesto } from "@lesto/web";

import { generateBearerToken, hashBearerToken } from "./bearer-tokens";
import { eventOccurrences, eventSeries } from "./events";
import { authenticatedAdult, people } from "./identity";
import { icsCalendarText } from "./ics";
import type { IcsEvent } from "./ics";
import { readableActiveTeam, teamAccess, teams } from "./teams";

export const calendarFeedTokens = defineTable("calendar_feed_tokens", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  personId: text("person_id")
    .notNull()
    .references(() => people.id),
  // Only the SHA-256 hex; the raw token exists in the mint response and
  // nowhere else (same posture as invitation tokens).
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const createCalendarFeeds: MigrationEntry = {
  version: "008_create_calendar_feeds",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(calendarFeedTokens, schema.dialect));
      await schema.execute(
        "CREATE INDEX calendar_feed_tokens_team_person_idx ON calendar_feed_tokens (team_id, person_id)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(calendarFeedTokens));
    },
  },
};

/**
 * The feed link shape — the ONE sanctioned request-line credential, because
 * calendar clients can carry it nowhere else. Its path shape is registered in
 * access-log.ts; a new secret-bearing route must never copy this without
 * copying that AND checking the seam actually runs on the tier that serves it
 * (for this route, today, it does not — see the header).
 */
export function calendarFeedPath(token: string): string {
  return `/calendar/feed/${token}`;
}

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;
const eventNotFound = { error: "event not found" } as const;
/** The ONE hiding answer every failed feed fetch gets, byte-identical. */
const feedNotFound = { error: "calendar feed not found" } as const;

/** How clients see the subscription; the team name is the only dynamic part. */
function calendarNameFor(teamName: string): string {
  return `${teamName} (Snackday)`;
}

function activeFeedRow(tx: Db, teamId: string, personId: string) {
  return tx
    .select()
    .from(calendarFeedTokens)
    .where(
      and(
        eq(calendarFeedTokens.teamId, teamId),
        eq(calendarFeedTokens.personId, personId),
        eq(calendarFeedTokens.status, "active"),
      ),
    )
    .get();
}

/**
 * Mint this adult's feed for this team — or ROTATE it if one is live. The raw
 * token is in this response and nowhere else, so minting again is exactly how
 * a mislaid URL is killed: the stored hash changes and the old link 404s.
 */
async function mintCalendarFeed(
  c: Context<"/api/teams/:teamId/calendar-feed">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const token = generateBearerToken();
  const tokenHash = await hashBearerToken(token);
  const outcome = await db.transaction(async (tx) => {
    const team = await readableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const now = new Date(clock()).toISOString();
    const existing = await activeFeedRow(tx, team.id, identity.person.id);
    if (existing === undefined) {
      await tx
        .insert(calendarFeedTokens)
        .values({
          id: `calendar_feed_${crypto.randomUUID()}`,
          teamId: team.id,
          personId: identity.person.id,
          tokenHash,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { created: true };
    }

    await tx
      .update(calendarFeedTokens)
      .set({ tokenHash, updatedAt: now })
      .where(eq(calendarFeedTokens.id, existing.id))
      .run();
    return { created: false };
  });

  if (outcome === null) return c.json(teamNotFound, 404);

  return c.json({ feed: { url: calendarFeedPath(token) } }, outcome.created ? 201 : 200);
}

/** Kill the feed with NO replacement; already-dead is an idempotent success. */
async function revokeCalendarFeed(
  c: Context<"/api/teams/:teamId/calendar-feed/revoke">,
  db: Db,
  sessions: Sessions,
  clock: Clock,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const outcome = await db.transaction(async (tx) => {
    const team = await readableActiveTeam(tx, c.param("teamId"), identity.person.id);
    if (team === undefined) return null;

    const existing = await activeFeedRow(tx, team.id, identity.person.id);
    if (existing !== undefined) {
      await tx
        .update(calendarFeedTokens)
        .set({ status: "revoked", updatedAt: new Date(clock()).toISOString() })
        .where(eq(calendarFeedTokens.id, existing.id))
        .run();
    }

    return { revoked: true };
  });

  if (outcome === null) return c.json(teamNotFound, 404);

  return c.json({ feed: { status: "revoked" } });
}

interface OccurrenceLikeRow {
  id: string;
  startsAtUtc: string;
  durationMinutes: number;
  status: string;
  updatedAt: string;
}

/**
 * One occurrence as the CHILD-FREE ICS event shape: the fields come from the
 * series and the occurrence only — never from people, participants, guardians,
 * or attendance. This function is the feed's entire vocabulary.
 */
function icsEventFor(
  series: { title: string; location: string | null; notes: string | null },
  occurrence: OccurrenceLikeRow,
): IcsEvent {
  return {
    uid: `${occurrence.id}@snackday`,
    summary: series.title,
    startsAt: occurrence.startsAtUtc,
    durationMinutes: occurrence.durationMinutes,
    ...(series.location === null ? {} : { location: series.location }),
    ...(series.notes === null ? {} : { description: series.notes }),
    cancelled: occurrence.status === "cancelled",
    updatedAt: occurrence.updatedAt,
  };
}

function icsResponse(body: string, extraHeaders: Record<string, string> = {}) {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Never indexed, never cached beyond the client that fetched it.
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "private, no-store",
      ...extraHeaders,
    },
    body,
  };
}

/** The whole team schedule as ICS — the feed body and nothing else. */
async function teamCalendarText(db: Db, teamId: string, teamName: string): Promise<string> {
  const seriesRows = await db
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.teamId, teamId), eq(eventSeries.status, "active")))
    .all();
  const seriesById = new Map(seriesRows.map((row) => [row.id, row] as const));

  const occurrenceRows = await db
    .select()
    .from(eventOccurrences)
    .where(eq(eventOccurrences.teamId, teamId))
    .all();
  occurrenceRows.sort(
    (left, right) =>
      left.startsAtUtc.localeCompare(right.startsAtUtc) || left.id.localeCompare(right.id),
  );

  const events = occurrenceRows.flatMap((occurrence) => {
    const series = seriesById.get(occurrence.seriesId);
    return series === undefined ? [] : [icsEventFor(series, occurrence)];
  });

  return icsCalendarText({ name: calendarNameFor(teamName), events });
}

/**
 * The pollable feed. No session — the token IS the credential — and one
 * byte-identical 404 for every way it can fail, exactly like invitation
 * previews: a feed URL is not proof a feed exists.
 */
async function serveCalendarFeed(c: Context<"/calendar/feed/:token">, db: Db) {
  const tokenHash = await hashBearerToken(c.param("token"));
  const row = await db
    .select()
    .from(calendarFeedTokens)
    .where(eq(calendarFeedTokens.tokenHash, tokenHash))
    .get();
  if (row === undefined || row.status !== "active") return c.json(feedNotFound, 404);

  // The feed dies with the adult's access: a revoked membership (or archived
  // team) turns the URL into the same hiding 404 an unknown token gets.
  const access = await teamAccess(db, row.teamId, row.personId);
  if (access === undefined) return c.json(feedNotFound, 404);

  return icsResponse(await teamCalendarText(db, access.team.id, access.team.name));
}

/** One occurrence as an authenticated `.ics` download — never a pollable URL. */
async function exportOccurrence(
  c: Context<"/api/teams/:teamId/occurrences/:occurrenceId/export">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const team = await readableActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(teamNotFound, 404);

  const occurrence = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(eq(eventOccurrences.id, c.param("occurrenceId")), eq(eventOccurrences.teamId, team.id)),
    )
    .get();
  if (occurrence === undefined) return c.json(eventNotFound, 404);

  const series = await db
    .select()
    .from(eventSeries)
    .where(and(eq(eventSeries.id, occurrence.seriesId), eq(eventSeries.status, "active")))
    .get();
  if (series === undefined) return c.json(eventNotFound, 404);

  const body = icsCalendarText({
    name: calendarNameFor(team.name),
    events: [icsEventFor(series, occurrence)],
  });

  // A fixed filename on purpose: an event title in a header invites both
  // encoding bugs and content a download bar should not repeat.
  return icsResponse(body, { "Content-Disposition": 'attachment; filename="snackday-event.ics"' });
}

export function registerCalendarFeedRoutes(
  app: Lesto,
  db: Db,
  sessions: Sessions,
  clock: Clock = Date.now,
) {
  return app
    .post("/api/teams/:teamId/calendar-feed", (c) => mintCalendarFeed(c, db, sessions, clock))
    .post("/api/teams/:teamId/calendar-feed/revoke", (c) =>
      revokeCalendarFeed(c, db, sessions, clock),
    )
    .get("/api/teams/:teamId/occurrences/:occurrenceId/export", (c) =>
      exportOccurrence(c, db, sessions),
    )
    .get("/calendar/feed/:token", (c) => serveCalendarFeed(c, db));
}
