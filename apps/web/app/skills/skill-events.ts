import { createTableSql, defineTable, dropTableSql, eq, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import {
  checkPassedEventSchema,
  rate,
  rulesV0,
  SKILL_EVENTS_CONTRACT,
  skillEventSchema,
  taxonomyV0,
} from "@snackday/skill-engine";
import type { Card, RulesetId, SkillEvent } from "@snackday/skill-engine";

import { participants } from "../lib/server/roster";
import { taxonomySkillForReelSkill } from "./reel-skill-map";

export const skillEvents = defineTable("skill_events", {
  id: text("id").primaryKey(),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id),
  event: text("event").notNull(),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const createSkillEvents: MigrationEntry = {
  version: "016_create_skill_events",
  migration: {
    up: async (schema) => {
      await schema.execute(createTableSql(skillEvents, schema.dialect));
      await schema.execute(
        "CREATE INDEX skill_events_participant_id_idx ON skill_events (participant_id)",
      );
    },
    down: async (schema) => {
      await schema.execute(dropTableSql(skillEvents));
    },
  },
};

export function playerIdFor(participantId: string): string {
  return `plr_${participantId.replaceAll(/[^A-Za-z0-9]/gu, "")}`;
}

export function localDateIn(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

async function checkPassedEventId(
  participantId: string,
  sourceId: string,
  quizId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`check_passed\n${participantId}\n${sourceId}\n${quizId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `evt_${hex.slice(0, 32)}`;
}

export interface PassedCheck {
  readonly participantId: string;
  readonly seriesId: string;
  readonly episodeSlug: string;
  readonly quizId: string;
  readonly reelSkill: string | undefined;
  readonly occurredAtMs: number;
  readonly timeZone: string;
}

const insertSkillEventSql = `INSERT INTO skill_events (id, participant_id, event, occurred_at, created_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING`;

export async function appendCheckPassed(tx: Db, check: PassedCheck): Promise<void> {
  const skill =
    check.reelSkill === undefined ? undefined : taxonomySkillForReelSkill(check.reelSkill);
  if (skill === undefined) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "skills.reel_skill_unmapped",
        reelSkill: check.reelSkill ?? null,
        source: `${check.seriesId}/${check.episodeSlug}`,
        itemId: check.quizId,
      }),
    );
    return;
  }
  const sourceId = `${check.seriesId}/${check.episodeSlug}`;
  const occurredAt = new Date(check.occurredAtMs).toISOString();
  const parsed = checkPassedEventSchema.safeParse({
    contract: SKILL_EVENTS_CONTRACT,
    id: await checkPassedEventId(check.participantId, sourceId, check.quizId),
    playerId: playerIdFor(check.participantId),
    occurredAt,
    localDate: localDateIn(check.occurredAtMs, check.timeZone),
    app: "snackday",
    type: "check_passed",
    skill,
    source: { kind: "reel-episode", id: sourceId, itemId: check.quizId },
  });
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "skills.event_invalid",
        source: sourceId,
        itemId: check.quizId,
      }),
    );
    return;
  }
  const event = parsed.data;
  await tx.raw(insertSkillEventSql, [
    event.id,
    check.participantId,
    JSON.stringify(event),
    occurredAt,
    occurredAt,
  ]);
}

export async function participantSkillEvents(tx: Db, participantId: string): Promise<SkillEvent[]> {
  const rows = await tx
    .select()
    .from(skillEvents)
    .where(eq(skillEvents.participantId, participantId))
    .all();
  return rows
    .map((row) => skillEventSchema.parse(JSON.parse(row.event)))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export const PLAYER_CARD_RULESET: RulesetId = "little-league";

export function rateParticipant(events: readonly SkillEvent[]): Card {
  return rate(events, taxonomyV0, rulesV0, { ruleset: PLAYER_CARD_RULESET });
}
