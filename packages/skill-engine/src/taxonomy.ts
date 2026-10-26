import { z } from "zod";
import taxonomyJson from "./taxonomy-v0.json";

export const SKILL_TAXONOMY_CONTRACT = "skill.taxonomy/v0";

const kebabPattern = "[a-z0-9]+(?:-[a-z0-9]+)*";

export const areaIdSchema = z.string().regex(new RegExp(`^${kebabPattern}$`, "u"));
export type AreaId = z.infer<typeof areaIdSchema>;

export const skillIdSchema = z
  .string()
  .regex(new RegExp(`^${kebabPattern}\\.${kebabPattern}$`, "u"));
export type SkillId = z.infer<typeof skillIdSchema>;

export const tierSchema = z.literal([1, 2, 3, 4]);
export type Tier = z.infer<typeof tierSchema>;

export const taxonomySkillSchema = z
  .strictObject({
    id: skillIdSchema,
    area: areaIdSchema,
    tier: tierSchema,
    ageMin: z.number().int().min(0).max(18),
    status: z.enum(["active", "retired"]),
  })
  .refine((skill) => skill.id.startsWith(`${skill.area}.`), {
    message: "Skill id must start with its area id",
  });
export type TaxonomySkill = z.infer<typeof taxonomySkillSchema>;

export const taxonomySchema = z
  .strictObject({
    contract: z.literal(SKILL_TAXONOMY_CONTRACT),
    areas: z.array(areaIdSchema).min(1),
    skills: z.array(taxonomySkillSchema).min(1),
  })
  .superRefine((taxonomy, context) => {
    const areas = new Set<string>();
    for (const area of taxonomy.areas) {
      if (areas.has(area)) {
        context.addIssue({ code: "custom", message: `Duplicate area id: ${area}` });
      }
      areas.add(area);
    }
    const skills = new Set<string>();
    for (const skill of taxonomy.skills) {
      if (skills.has(skill.id)) {
        context.addIssue({ code: "custom", message: `Duplicate skill id: ${skill.id}` });
      }
      skills.add(skill.id);
      if (!areas.has(skill.area)) {
        context.addIssue({
          code: "custom",
          message: `Unknown area for ${skill.id}: ${skill.area}`,
        });
      }
    }
  });
export type Taxonomy = z.infer<typeof taxonomySchema>;

export const taxonomyV0: Taxonomy = taxonomySchema.parse(taxonomyJson);
