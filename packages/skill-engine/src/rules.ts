import { z } from "zod";
import rulesJson from "./rules-v0.json";

export const SKILL_RULES_CONTRACT = "skill.rules/v0";

const perTier = (value: z.ZodNumber) =>
  z.strictObject({ "1": value, "2": value, "3": value, "4": value });

const streakRowSchema = z.strictObject({
  minDays: z.number().int().min(1),
  multiplier: z.number().min(1),
});

export const rulesSchema = z
  .strictObject({
    contract: z.literal(SKILL_RULES_CONTRACT),
    tierPoints: perTier(z.number().positive()),
    moduleMultiplier: z.number().positive(),
    eventPoints: z.strictObject({
      check_passed: z.number().min(0),
      history_learned: z.number().min(0),
      high_five: z.number().min(0),
      card_collected: z.number().min(0),
    }),
    streakMultiplied: z.array(
      z.enum([
        "drill_completed",
        "module_completed",
        "check_passed",
        "history_learned",
        "high_five",
        "card_collected",
      ]),
    ),
    streak: z.array(streakRowSchema).min(1),
    k: perTier(z.number().positive()),
    restDay: z.strictObject({ windowDays: z.number().int().min(0) }),
    ratingScale: z.number().positive(),
    maxRating: z.number().int().positive(),
  })
  .superRefine((rules, context) => {
    if (rules.streak[0]?.minDays !== 1) {
      context.addIssue({ code: "custom", message: "Streak table must start at 1 day" });
    }
    for (let index = 1; index < rules.streak.length; index += 1) {
      const previous = rules.streak[index - 1];
      const row = rules.streak[index];
      if (
        previous &&
        row &&
        (row.minDays <= previous.minDays || row.multiplier < previous.multiplier)
      ) {
        context.addIssue({
          code: "custom",
          message: "Streak table must rise by days and multiplier",
        });
      }
    }
  });
export type Rules = z.infer<typeof rulesSchema>;

export const rulesV0: Rules = rulesSchema.parse(rulesJson);
