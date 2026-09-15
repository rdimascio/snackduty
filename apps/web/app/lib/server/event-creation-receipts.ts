import { createTableSql, defineTable, dropTableSql, text } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { accounts, people } from "./identity";
import { teams, seasons } from "./teams";
import { eventSeries } from "./occurrence-access";
import { dutySlots } from "./duties";

export const eventCreationReceipts = defineTable("event_creation_receipts", {
  id: text("id").primaryKey(),
  actorAccountId: text("actor_account_id")
    .notNull()
    .references(() => accounts.id),
  actorPersonId: text("actor_person_id")
    .notNull()
    .references(() => people.id),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  seriesId: text("series_id")
    .notNull()
    .references(() => eventSeries.id),
  dutySlotId: text("duty_slot_id").references(() => dutySlots.id),
  createdAt: text("created_at").notNull(),
});
export const createEventCreationReceipts: MigrationEntry = {
  version: "013_create_event_creation_receipts",
  migration: {
    up(schema) {
      schema.execute(createTableSql(eventCreationReceipts));
      schema.execute(
        "CREATE UNIQUE INDEX event_creation_receipts_request_idx ON event_creation_receipts (actor_account_id, team_id, season_id, request_id)",
      );
    },
    down(schema) {
      schema.execute(dropTableSql(eventCreationReceipts));
    },
  },
};
