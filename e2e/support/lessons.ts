import { FIXTURE_LESSON } from "./reel-fixture";
import type { Scenario } from "./scenario";

export interface LessonAnswerRow {
  readonly id: string;
  readonly series_id: string;
  readonly episode_slug: string;
  readonly quiz_id: string;
  readonly answer_index: number;
  readonly outcome: string;
  readonly recorded_by_person_id: string;
}

export interface SkillEventRow {
  readonly id: string;
  readonly event: string;
}

export interface CardWriteRows {
  readonly answers: readonly LessonAnswerRow[];
  readonly events: readonly SkillEventRow[];
}

export function lessonAnswersPath(teamId: string): string {
  return `/api/teams/${teamId}/lessons/current/answers`;
}

export function correctAnswer(participantId: string) {
  return {
    participantId,
    quizId: FIXTURE_LESSON.quizId,
    answer: FIXTURE_LESSON.correctAnswer,
  };
}

export function cardWriteRows(scenario: Scenario, participantId: string): CardWriteRows {
  return {
    answers: scenario.query<LessonAnswerRow>(
      "SELECT id, series_id, episode_slug, quiz_id, answer_index, outcome, recorded_by_person_id FROM lesson_answers WHERE participant_id = ? ORDER BY id",
      participantId,
    ),
    events: scenario.query<SkillEventRow>(
      "SELECT id, event FROM skill_events WHERE participant_id = ? ORDER BY id",
      participantId,
    ),
  };
}
