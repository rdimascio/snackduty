import { DevScenarioApi, ensure } from "./dev-scenario-api";

interface CurrentLessonResponse {
  readonly lesson?: {
    readonly seriesId?: string;
    readonly slug?: string;
    readonly title?: string;
    readonly quiz?: readonly { readonly id?: string; readonly choices?: readonly unknown[] }[];
  };
}

interface SkillCardResponse {
  readonly overall?: number;
  readonly areas?: readonly { readonly area?: string; readonly rating?: number }[];
  readonly skills?: readonly { readonly streakAtLast?: number; readonly points?: number }[];
}

export interface DevScenarioLesson {
  readonly seriesId: string;
  readonly slug: string;
  readonly title: string;
  readonly quiz: readonly { readonly id: string; readonly choiceCount: number }[];
}

export interface DevScenarioSkillCard {
  readonly overall: number;
  readonly areas: readonly { readonly area: string; readonly rating: number }[];
  readonly streakDays: number;
  readonly scoredSkills: number;
}

export class DevScenarioLessonApi extends DevScenarioApi {
  async readCurrentLesson(cookie: string, teamId: string): Promise<DevScenarioLesson> {
    const step = "read-current-lesson";
    const body = await this.json<CurrentLessonResponse>(
      step,
      `/api/teams/${teamId}/lessons/current`,
      { headers: { Cookie: cookie } },
      200,
    );
    const lesson = body.lesson;
    ensure(
      step,
      typeof lesson?.seriesId === "string" &&
        typeof lesson.slug === "string" &&
        typeof lesson.title === "string",
      "response carries no lesson identity",
    );
    const quiz = (lesson.quiz ?? []).flatMap((item) =>
      typeof item.id === "string" && Array.isArray(item.choices)
        ? [{ id: item.id, choiceCount: item.choices.length }]
        : [],
    );
    ensure(step, quiz.length > 0, "the current lesson carries no quiz items");
    return { seriesId: lesson.seriesId, slug: lesson.slug, title: lesson.title, quiz };
  }

  async answerLesson(
    cookie: string,
    teamId: string,
    answer: { readonly participantId: string; readonly quizId: string; readonly answer: number },
  ): Promise<"correct" | "try_again"> {
    const step = "answer-lesson";
    const body = await this.json<{ answer?: { outcome?: string } }>(
      step,
      `/api/teams/${teamId}/lessons/current/answers`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(answer) },
      200,
    );
    const outcome = body.answer?.outcome;
    ensure(
      step,
      outcome === "correct" || outcome === "try_again",
      "response carries no answer outcome",
    );
    return outcome;
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
