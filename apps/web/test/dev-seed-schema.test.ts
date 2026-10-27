import { readdir } from "node:fs/promises";

import { openSqlite } from "@lesto/runtime";
import { createDb } from "@lesto/db";
import type { SqlDatabase } from "@lesto/db";
import { skillEventSchema } from "@snackday/skill-engine";
import { afterEach, describe, expect, it } from "vitest";

import { applySeed, migrateDatabase, SEED_DIRECTORY, seedFiles } from "../app/dev/seed-database";
import {
  SEED_CALENDAR_FEED,
  SEED_CHILDREN,
  SEED_INVITATIONS,
  SEED_PERSONAS,
  SEED_SCHEDULE,
  SEED_TEAMS,
  SEED_TIME_ZONE,
} from "../app/dev/seed-personas";
import { hashBearerToken } from "../app/lib/server/bearer-tokens";
import { instantFromWallTime, scheduleDates } from "../app/lib/server/event-time";
import { ensureDevelopmentPersona } from "../app/lib/server/identity";
import { rateParticipant } from "../app/skills/skill-events";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MONDAY_NOON_PHOENIX = Date.UTC(2026, 9, 26, 19);

const handles: (() => void)[] = [];

afterEach(() => {
  for (const close of handles.splice(0)) close();
});

async function migrated(): Promise<SqlDatabase> {
  const { db, close } = await openSqlite(":memory:");
  handles.push(close);
  await migrateDatabase(db);
  return db;
}

async function seeded(): Promise<SqlDatabase> {
  const db = await migrated();
  await applySeed(db);
  return db;
}

async function rows<T>(db: SqlDatabase, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.prepare(sql).all(params)) as T[];
}

describe("the SQL dev seed against the current migrations", () => {
  it("applies every seed file in order to a freshly migrated database", async () => {
    const names = (await readdir(SEED_DIRECTORY)).filter((name) => name.endsWith(".sql"));
    expect(names.length).toBeGreaterThan(0);
    expect((await seedFiles()).length).toBe(names.length);
    const db = await migrated();
    expect(await applySeed(db)).toEqual(names.toSorted());
  });

  it("applies on top of a database where the iOS personas already signed in", async () => {
    const db = await migrated();
    await ensureDevelopmentPersona(createDb(db), "default");
    await ensureDevelopmentPersona(createDb(db), "second-adult");
    await expect(applySeed(db)).resolves.toHaveLength((await seedFiles()).length);
  });

  it("names the failing seed file when a column moves under it", async () => {
    const db = await migrated();
    await db.exec("ALTER TABLE duty_slots DROP COLUMN instructions");
    await expect(applySeed(db)).rejects.toThrow(/seed\/005_duties\.sql/u);
    expect(await rows(db, "SELECT id FROM people")).toEqual([]);
  });

  it("seeds every role persona as an active adult with the exported ids", async () => {
    const db = await seeded();
    for (const persona of SEED_PERSONAS) {
      const [row] = await rows<{ display_name: string; person_status: string; status: string }>(
        db,
        "SELECT people.display_name, people.status AS person_status, accounts.status FROM accounts JOIN people ON people.id = accounts.person_id WHERE accounts.id = ? AND people.id = ?",
        [persona.accountId, persona.personId],
      );
      expect(row).toEqual({
        display_name: persona.displayName,
        person_status: "active",
        status: "active",
      });
    }
    const identityDb = createDb(db);
    await expect(ensureDevelopmentPersona(identityDb, "default")).resolves.toBeDefined();
    await expect(ensureDevelopmentPersona(identityDb, "second-adult")).resolves.toBeDefined();
  });

  it("seeds the exported teams and children", async () => {
    const db = await seeded();
    for (const team of Object.values(SEED_TEAMS)) {
      expect(
        await rows(
          db,
          "SELECT teams.name, seasons.label, seasons.time_zone FROM teams JOIN seasons ON seasons.team_id = teams.id WHERE teams.id = ? AND seasons.id = ?",
          [team.teamId, team.seasonId],
        ),
      ).toEqual([{ name: team.name, label: team.seasonLabel, time_zone: SEED_TIME_ZONE }]);
    }
    for (const child of Object.values(SEED_CHILDREN)) {
      expect(
        await rows(
          db,
          "SELECT people.display_name FROM participants JOIN people ON people.id = participants.person_id WHERE participants.id = ?",
          [child.participantId],
        ),
      ).toEqual([{ display_name: child.displayName }]);
    }
  });

  it("materializes occurrences exactly as the app would for each series", async () => {
    const db = await seeded();
    const series = await rows<{
      id: string;
      title: string;
      time_zone: string;
      local_time: string;
      duration_minutes: number;
      frequency: "once" | "weekly";
      by_weekday: string | null;
      start_date: string;
      until_date: string | null;
    }>(db, "SELECT * FROM event_series");
    expect(series.map((row) => row.title).toSorted()).toEqual(
      [
        SEED_SCHEDULE.practiceTitle,
        ...SEED_SCHEDULE.gameTitles,
        SEED_SCHEDULE.secondTeamEventTitle,
      ].toSorted(),
    );
    for (const row of series) {
      const occurrences = await rows<{ local_date: string; starts_at_utc: string }>(
        db,
        "SELECT local_date, starts_at_utc FROM event_occurrences WHERE series_id = ? ORDER BY local_date",
        [row.id],
      );
      const dates = scheduleDates(
        {
          timeZone: row.time_zone,
          localTime: row.local_time,
          durationMinutes: row.duration_minutes,
          frequency: row.frequency,
          ...(row.by_weekday === null ? {} : { byWeekday: JSON.parse(row.by_weekday) as never }),
          startDate: row.start_date,
          ...(row.until_date === null ? {} : { untilDate: row.until_date }),
        },
        201,
      );
      expect(occurrences.map((occurrence) => occurrence.local_date)).toEqual(dates);
      for (const occurrence of occurrences) {
        expect(occurrence.starts_at_utc).toBe(
          instantFromWallTime(occurrence.local_date, row.local_time, row.time_zone),
        );
      }
    }
    expect(
      await rows(
        db,
        "SELECT event_series.title FROM event_occurrences JOIN event_series ON event_series.id = event_occurrences.series_id WHERE event_occurrences.status = 'cancelled'",
      ),
    ).toEqual([{ title: SEED_SCHEDULE.cancelledGameTitle }]);
  });

  it("keeps every event from today through the next three weeks on every weekday", async () => {
    const days: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const now = new Date(MONDAY_NOON_PHOENIX + offset * DAY_MS);
      const today = now.toISOString().slice(0, 10);
      const db = await migrated();
      await applySeed(db, { now });
      const [span] = await rows<{ first: string; last: string }>(
        db,
        "SELECT min(local_date) AS first, max(local_date) AS last FROM event_occurrences",
      );
      const first = Date.parse(span?.first ?? "") - Date.parse(today);
      const last = Date.parse(span?.last ?? "") - Date.parse(today);
      expect({ today, first: first >= 0, last: last <= 21 * DAY_MS }).toEqual({
        today,
        first: true,
        last: true,
      });
      days.push(new Date(today).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }));
    }
    expect(days.toSorted()).toEqual([
      "Friday",
      "Monday",
      "Saturday",
      "Sunday",
      "Thursday",
      "Tuesday",
      "Wednesday",
    ]);
  });

  it("seeds open and claimed duty slots and guardian RSVPs", async () => {
    const db = await seeded();
    const [duties] = await rows<{ open: number; claimed: number }>(
      db,
      "SELECT sum(assignee_person_id IS NULL) AS open, sum(assignee_person_id IS NOT NULL) AS claimed FROM duty_slots",
    );
    expect(duties?.open).toBeGreaterThan(0);
    expect(duties?.claimed).toBeGreaterThan(0);
    expect(
      await rows(
        db,
        "SELECT count(*) AS n FROM duty_slots JOIN event_occurrences ON event_occurrences.id = duty_slots.occurrence_id WHERE event_occurrences.status = 'cancelled'",
      ),
    ).toEqual([{ n: 0 }]);
    const recorders = await rows<{ guardians: number; total: number }>(
      db,
      "SELECT count(*) AS total, sum(EXISTS (SELECT 1 FROM guardian_relationships WHERE guardian_relationships.participant_id = event_attendance.participant_id AND guardian_relationships.guardian_person_id = event_attendance.recorded_by_person_id)) AS guardians FROM event_attendance",
    );
    expect(recorders[0]?.total).toBeGreaterThan(0);
    expect(recorders[0]?.guardians).toBe(recorders[0]?.total);
  });

  it("stores valid skill events that rate the first child above zero", async () => {
    const db = await seeded();
    const events = await rows<{ participant_id: string; event: string }>(
      db,
      "SELECT participant_id, event FROM skill_events",
    );
    expect(events.length).toBeGreaterThan(0);
    const parsed = events.map((row) => skillEventSchema.parse(JSON.parse(row.event)));
    const avery = parsed.filter(
      (_, index) => events[index]?.participant_id === SEED_CHILDREN.avery.participantId,
    );
    expect(avery.every((event) => Date.parse(event.occurredAt) <= Date.now())).toBe(true);
    const card = rateParticipant(avery);
    expect(card.overall).toBeGreaterThan(0);
  });

  it("stores the hashes of the exported invitation and calendar feed tokens", async () => {
    const db = await seeded();
    for (const invitation of Object.values(SEED_INVITATIONS)) {
      expect(
        await rows(db, "SELECT status FROM invitations WHERE id = ? AND token_hash = ?", [
          invitation.id,
          await hashBearerToken(invitation.token),
        ]),
      ).toEqual([{ status: "pending" }]);
    }
    expect(
      await rows(db, "SELECT team_id FROM calendar_feed_tokens WHERE id = ? AND token_hash = ?", [
        SEED_CALENDAR_FEED.id,
        await hashBearerToken(SEED_CALENDAR_FEED.token),
      ]),
    ).toEqual([{ team_id: SEED_CALENDAR_FEED.teamId }]);
  });
});
