import type { ReactNode } from "react";
import { useState } from "react";

import { refreshPlayerCard } from "../skills/player-card-updates";

export interface LessonAnswerPlayer {
  readonly participantId: string;
  readonly label: string;
}

export interface LessonAnswerPrompt {
  readonly id: string;
  readonly prompt: string;
  readonly choices: readonly string[];
}

export interface LessonAnswerResult {
  readonly participantId: string;
  readonly quizId: string;
  readonly answer: number;
  readonly outcome: "correct" | "try_again";
  readonly feedback: string;
}

export type LessonAnswersProps = {
  readonly teamId: string;
  readonly quiz: readonly LessonAnswerPrompt[];
  readonly players: readonly LessonAnswerPlayer[];
  readonly answers: readonly LessonAnswerResult[];
};

export type AnswerPoster = (url: string, body: unknown) => Promise<{ ok: boolean; json: unknown }>;

export type PlayerCardRefresher = (teamId: string, participantId: string) => Promise<unknown>;

interface AnswerResponse {
  readonly answer: {
    readonly participantId: string;
    readonly quizId: string;
    readonly answer: number;
    readonly outcome: "correct" | "try_again";
  };
  readonly feedback: string;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, json: response.ok ? ((await response.json()) as unknown) : undefined };
}

export async function submitLessonAnswer(
  teamId: string,
  participantId: string,
  quizId: string,
  answer: number,
  post: AnswerPoster = postJson,
): Promise<LessonAnswerResult | undefined> {
  const response = await post(`/api/teams/${encodeURIComponent(teamId)}/lessons/current/answers`, {
    participantId,
    quizId,
    answer,
  });
  if (!response.ok) return undefined;
  const { answer: stored, feedback } = response.json as AnswerResponse;
  return {
    participantId: stored.participantId,
    quizId: stored.quizId,
    answer: stored.answer,
    outcome: stored.outcome,
    feedback,
  };
}

export function mergeLessonAnswer(
  answers: readonly LessonAnswerResult[],
  result: LessonAnswerResult,
): LessonAnswerResult[] {
  return [
    ...answers.filter(
      (entry) => !(entry.participantId === result.participantId && entry.quizId === result.quizId),
    ),
    result,
  ];
}

function FeedbackLine({ result }: { result: LessonAnswerResult | undefined }): ReactNode {
  if (result === undefined) return null;
  return (
    <p
      className={
        result.outcome === "correct"
          ? "mt-3 text-sm font-semibold text-primary"
          : "mt-3 text-sm font-semibold text-muted-foreground"
      }
      role="status"
    >
      {result.feedback}
    </p>
  );
}

function answerFor(
  answers: readonly LessonAnswerResult[],
  participantId: string | undefined,
  quizId: string,
): LessonAnswerResult | undefined {
  return answers.find((entry) => entry.participantId === participantId && entry.quizId === quizId);
}

export function LessonAnswersShell({ quiz, players, answers }: LessonAnswersProps): ReactNode {
  const participantId = players[0]?.participantId;
  return (
    <ol aria-label="Lesson questions" className="mt-5 space-y-4">
      {quiz.map((item) => (
        <li className="rounded-xl border border-border p-4" key={item.id}>
          <p className="font-semibold">{item.prompt}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {item.choices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ul>
          <FeedbackLine result={answerFor(answers, participantId, item.id)} />
        </li>
      ))}
    </ol>
  );
}

export function LessonAnswers({
  teamId,
  quiz,
  players,
  answers: initialAnswers,
  post,
  refreshCard = refreshPlayerCard,
}: LessonAnswersProps & {
  readonly post?: AnswerPoster;
  readonly refreshCard?: PlayerCardRefresher;
}): ReactNode {
  const [participantId, setParticipantId] = useState(players[0]?.participantId);
  const [answers, setAnswers] = useState<readonly LessonAnswerResult[]>(initialAnswers);
  const [pending, setPending] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  async function choose(quizId: string, choice: number) {
    if (participantId === undefined) return;
    setPending(quizId);
    setFailed(false);
    try {
      const result = await submitLessonAnswer(teamId, participantId, quizId, choice, post);
      if (result === undefined) {
        setFailed(true);
      } else {
        setAnswers((current) => mergeLessonAnswer(current, result));
        void refreshCard(teamId, participantId).catch(() => null);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="mt-5">
      {players.length > 1 ? (
        <label className="block text-sm font-semibold">
          Answering for
          <select
            className="mt-1 block rounded-lg border border-border bg-background px-3 py-2"
            onChange={(event) => setParticipantId(event.currentTarget.value)}
            value={participantId}
          >
            {players.map((player) => (
              <option key={player.participantId} value={player.participantId}>
                {player.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm font-semibold">Answering for {players[0]?.label}</p>
      )}
      <ol aria-label="Lesson questions" className="mt-4 space-y-4">
        {quiz.map((item) => {
          const result = answerFor(answers, participantId, item.id);
          return (
            <li className="rounded-xl border border-border p-4" key={item.id}>
              <p className="font-semibold">{item.prompt}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {item.choices.map((choice, index) => (
                  <button
                    aria-pressed={result?.answer === index}
                    className="rounded-lg border border-border px-3 py-2 text-sm font-semibold aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                    disabled={pending === item.id}
                    key={choice}
                    onClick={() => void choose(item.id, index)}
                    type="button"
                  >
                    {choice}
                  </button>
                ))}
              </div>
              <FeedbackLine result={result} />
            </li>
          );
        })}
      </ol>
      {failed ? (
        <p className="mt-3 text-sm text-muted-foreground" role="alert">
          That answer did not save. Try again.
        </p>
      ) : null}
    </div>
  );
}
