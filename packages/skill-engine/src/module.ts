import { z } from "zod";
import { skillIdSchema, taxonomyV0 } from "./taxonomy";

export const SKILL_MODULE_CONTRACT = "skill.module/v0";

const kebabSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const textSchema = z.string().trim().min(1);
const fieldCoordinateSchema = z.number().min(0).max(100);

const fieldPositionSchema = z.strictObject({
  id: kebabSchema,
  label: textSchema,
  x: fieldCoordinateSchema,
  y: fieldCoordinateSchema,
});

const fieldArrowSchema = z.strictObject({
  from: kebabSchema,
  to: kebabSchema,
  kind: z.enum(["throw", "run"]),
});

export const fieldDiagramSchema = z
  .strictObject({
    kind: z.literal("field"),
    positions: z.array(fieldPositionSchema).min(1),
    arrows: z.array(fieldArrowSchema),
  })
  .superRefine((diagram, context) => {
    const positions = new Set<string>();
    diagram.positions.forEach((position, index) => {
      if (positions.has(position.id)) {
        context.addIssue({
          code: "custom",
          path: ["positions", index, "id"],
          message: `Duplicate position id: ${position.id}`,
        });
      }
      positions.add(position.id);
    });
    diagram.arrows.forEach((arrow, index) => {
      for (const end of ["from", "to"] as const) {
        if (!positions.has(arrow[end])) {
          context.addIssue({
            code: "custom",
            path: ["arrows", index, end],
            message: `Unknown position: ${arrow[end]}`,
          });
        }
      }
    });
  });
export type FieldDiagram = z.infer<typeof fieldDiagramSchema>;

export const moduleVideoSchema = z.strictObject({
  releaseId: textSchema,
  url: z.url({ protocol: /^https$/u }),
});
export type ModuleVideo = z.infer<typeof moduleVideoSchema>;

export const moduleLessonSchema = z.strictObject({
  id: kebabSchema,
  title: textSchema,
  script: z.array(textSchema).min(1),
  diagram: fieldDiagramSchema.optional(),
  video: moduleVideoSchema.optional(),
});
export type ModuleLesson = z.infer<typeof moduleLessonSchema>;

export const moduleCheckSchema = z
  .strictObject({
    id: kebabSchema,
    prompt: textSchema,
    choices: z.array(textSchema).min(2).max(4),
    answer: z.number().int().min(0),
    feedback: z.strictObject({ correct: textSchema, wrong: textSchema }),
  })
  .refine((check) => check.answer < check.choices.length, {
    path: ["answer"],
    message: "Answer index out of range",
  });
export type ModuleCheck = z.infer<typeof moduleCheckSchema>;

export const moduleDrillSchema = z.strictObject({
  id: kebabSchema,
  title: textSchema,
  skill: skillIdSchema,
  setup: textSchema,
  steps: z.array(textSchema).min(1),
  reps: textSchema,
  coachingPoints: z.array(textSchema).min(1),
});
export type ModuleDrill = z.infer<typeof moduleDrillSchema>;

const knownSkills = new Set(taxonomyV0.skills.map((skill) => skill.id));

export const skillModuleSchema = z
  .strictObject({
    contract: z.literal(SKILL_MODULE_CONTRACT),
    id: kebabSchema,
    version: z.number().int().min(1),
    skill: skillIdSchema,
    ageMin: z.number().int().min(0).max(18),
    lessons: z.array(moduleLessonSchema).min(1),
    checks: z.array(moduleCheckSchema).min(1),
    drills: z.array(moduleDrillSchema).min(1),
  })
  .superRefine((module, context) => {
    if (!knownSkills.has(module.skill)) {
      context.addIssue({
        code: "custom",
        path: ["skill"],
        message: `Unknown skill: ${module.skill}`,
      });
    }
    module.drills.forEach((drill, index) => {
      if (!knownSkills.has(drill.skill)) {
        context.addIssue({
          code: "custom",
          path: ["drills", index, "skill"],
          message: `Unknown skill: ${drill.skill}`,
        });
      }
    });
    const itemIds = new Set<string>();
    for (const key of ["lessons", "checks", "drills"] as const) {
      module[key].forEach((item, index) => {
        if (itemIds.has(item.id)) {
          context.addIssue({
            code: "custom",
            path: [key, index, "id"],
            message: `Duplicate item id: ${item.id}`,
          });
        }
        itemIds.add(item.id);
      });
    }
  });
export type SkillModule = z.infer<typeof skillModuleSchema>;
