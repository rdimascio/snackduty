import { DevScenarioApi, ensure } from "./dev-scenario-api";

interface SkillCardResponse {
  readonly overall?: number;
  readonly areas?: readonly { readonly area?: string; readonly rating?: number }[];
  readonly skills?: readonly { readonly streakAtLast?: number; readonly points?: number }[];
}

export interface DevScenarioSkillCard {
  readonly overall: number;
  readonly areas: readonly { readonly area: string; readonly rating: number }[];
  readonly streakDays: number;
  readonly scoredSkills: number;
}

export class DevScenarioLessonApi extends DevScenarioApi {
  async seedSkillEvents(
    cookie: string,
    teamId: string,
    participantId: string,
    events: readonly unknown[],
  ): Promise<number> {
    const step = "seed-skill-events";
    const body = await this.json<{ recorded?: number; duplicates?: number }>(
      step,
      `/api/dev/teams/${teamId}/participants/${participantId}/skill-events`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(events) },
      200,
    );
    ensure(
      step,
      typeof body.recorded === "number" && typeof body.duplicates === "number",
      "response carries no recorded count",
    );
    ensure(
      step,
      body.recorded + body.duplicates === events.length,
      "the seed route did not account for every event",
    );
    return body.recorded;
  }

  async readSkillCard(
    cookie: string,
    teamId: string,
    participantId: string,
  ): Promise<DevScenarioSkillCard> {
    const step = "read-skill-card";
    const body = await this.json<SkillCardResponse>(
      step,
      `/api/teams/${teamId}/participants/${participantId}/skill-card`,
      { headers: { Cookie: cookie } },
      200,
    );
    ensure(step, typeof body.overall === "number", "response carries no overall rating");
    const areas = (body.areas ?? []).flatMap((entry) =>
      typeof entry.area === "string" && typeof entry.rating === "number"
        ? [{ area: entry.area, rating: entry.rating }]
        : [],
    );
    const skills = body.skills ?? [];
    const streakDays = Math.max(
      0,
      ...skills.map((skill) => (typeof skill.streakAtLast === "number" ? skill.streakAtLast : 0)),
    );
    const scoredSkills = skills.filter(
      (skill) => typeof skill.points === "number" && skill.points > 0,
    ).length;
    return { overall: body.overall, areas, streakDays, scoredSkills };
  }
}
