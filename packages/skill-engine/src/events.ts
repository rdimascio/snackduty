import { z } from "zod";
import { skillIdSchema } from "./taxonomy";

export const SKILL_EVENTS_CONTRACT = "skill.events/v0";

export const HISTORY_SKILL = "baseball-iq.history";

const kebabSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const refSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u);

export const eventIdSchema = z.string().regex(/^evt_[A-Za-z0-9]+$/u);
export type EventId = z.infer<typeof eventIdSchema>;

export const playerIdSchema = z.string().regex(/^plr_[A-Za-z0-9]+$/u);
export type PlayerId = z.infer<typeof playerIdSchema>;

export const eventSourceSchema = z.strictObject({
  kind: kebabSchema,
  id: refSchema,
  version: z.number().int().min(1).optional(),
  itemId: kebabSchema.optional(),
});
export type EventSource = z.infer<typeof eventSourceSchema>;

export const moduleSourceSchema = z.strictObject({
  kind: z.literal("module"),
  id: refSchema,
  version: z.number().int().min(1),
  itemId: kebabSchema.optional(),
});

const baseShape = {
  contract: z.literal(SKILL_EVENTS_CONTRACT),
  id: eventIdSchema,
  playerId: playerIdSchema,
  occurredAt: z.iso.datetime(),
  localDate: z.iso.date(),
  app: z.enum(["ballplayer", "snackday"]),
};

export const drillCompletedEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("drill_completed"),
  skill: skillIdSchema,
  source: eventSourceSchema,
});

export const moduleCompletedEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("module_completed"),
  skill: skillIdSchema,
  source: moduleSourceSchema,
});

export const checkPassedEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("check_passed"),
  skill: skillIdSchema,
  source: eventSourceSchema,
});

export const historyLearnedEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("history_learned"),
  skill: z.literal(HISTORY_SKILL),
  source: eventSourceSchema,
});

export const highFiveEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("high_five"),
  skill: skillIdSchema,
  source: eventSourceSchema,
});

export const cardCollectedEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("card_collected"),
  source: eventSourceSchema,
});

export const voidEventSchema = z.strictObject({
  ...baseShape,
  type: z.literal("void"),
  voids: eventIdSchema,
});

export const skillEventSchema = z.discriminatedUnion("type", [
  drillCompletedEventSchema,
  moduleCompletedEventSchema,
  checkPassedEventSchema,
  historyLearnedEventSchema,
  highFiveEventSchema,
  cardCollectedEventSchema,
  voidEventSchema,
]);
export type SkillEvent = z.infer<typeof skillEventSchema>;
export type SkillEventType = SkillEvent["type"];

export function parseSkillEvents(input: unknown): SkillEvent[] {
  return z.array(skillEventSchema).parse(input);
}
