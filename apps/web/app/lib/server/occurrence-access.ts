import { and, defineTable, eq, integer, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { DomainPermission } from "@snackday/domain";

import { authorizeTeamOperation } from "./authorization";
import { seasons, teams } from "./teams";

export const eventSeries = defineTable("event_series", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  location: text("location"),
  notes: text("notes"),
  timeZone: text("time_zone").notNull(),
  localTime: text("local_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  frequency: text("frequency").notNull(),
  byWeekday: text("by_weekday"),
  startDate: text("start_date").notNull(),
  untilDate: text("until_date"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const eventOccurrences = defineTable("event_occurrences", {
  id: text("id").primaryKey(),
  seriesId: text("series_id")
    .notNull()
    .references(() => eventSeries.id),
  // This denormalized team is always checked against the authoritative series
  // before access is granted. It is an index key, never standalone authority.
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  localDate: text("local_date").notNull(),
  startsAtUtc: text("starts_at_utc").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  status: text("status").notNull(),
  cancelledReason: text("cancelled_reason"),
  cancelledAt: text("cancelled_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Resolve an active same-team season and ask the canonical policy for access. */
export async function activeSeasonForOperation(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: { readonly teamId: string; readonly seasonId: string },
) {
  const season = await db
    .select()
    .from(seasons)
    .where(
      and(
        eq(seasons.id, target.seasonId),
        eq(seasons.teamId, target.teamId),
        eq(seasons.status, "active"),
      ),
    )
    .get();
  if (season === undefined) return;

  const authorized = await authorizeTeamOperation(db, personId, permission, target);
  return authorized ? season : undefined;
}

/** Resolve an active series whose team and season both pass canonical policy. */
export async function activeSeriesForOperation(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: { readonly teamId: string; readonly seriesId: string },
) {
  const series = await db
    .select()
    .from(eventSeries)
    .where(
      and(
        eq(eventSeries.id, target.seriesId),
        eq(eventSeries.teamId, target.teamId),
        eq(eventSeries.status, "active"),
      ),
    )
    .get();
  if (series === undefined) return;

  const season = await activeSeasonForOperation(db, personId, permission, {
    teamId: target.teamId,
    seasonId: series.seasonId,
  });
  return season === undefined ? undefined : { series, season };
}

/**
 * Resolve an occurrence through its authoritative active series and season.
 * The denormalized occurrence team must agree too, preventing a corrupt or
 * forged cross-team row from becoming an authorization shortcut.
 */
export async function activeOccurrenceForOperation(
  db: Db,
  personId: string,
  permission: DomainPermission,
  target: { readonly teamId: string; readonly occurrenceId: string },
) {
  const occurrence = await db
    .select()
    .from(eventOccurrences)
    .where(
      and(eq(eventOccurrences.id, target.occurrenceId), eq(eventOccurrences.teamId, target.teamId)),
    )
    .get();
  if (occurrence === undefined) return;

  const resolved = await activeSeriesForOperation(db, personId, permission, {
    teamId: target.teamId,
    seriesId: occurrence.seriesId,
  });
  return resolved === undefined ? undefined : { occurrence, ...resolved };
}
