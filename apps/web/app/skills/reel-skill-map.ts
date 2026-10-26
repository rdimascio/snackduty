import type { SkillId } from "@snackday/skill-engine";

export const reelSkillMap: Readonly<Record<string, SkillId>> = {
  "run-to-first": "baserunning.out-of-the-box",
  "run-through-first": "baserunning.out-of-the-box",
  "ready-position": "infield.ready-position",
  "watch-the-ball": "mental.failure",
  "mistakes-are-ok": "mental.failure",
  "reset-routine": "mental.failure",
  "cheer-teammates": "mental.failure",
};

export function taxonomySkillForReelSkill(reelSkill: string): SkillId | undefined {
  return Object.hasOwn(reelSkillMap, reelSkill) ? reelSkillMap[reelSkill] : undefined;
}
