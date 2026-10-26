import type { ReactNode } from "react";

import type { LessonCardData } from "./lessons";

export function formatLessonDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes === 0) return `${remainder} sec`;
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} sec`;
}

function completedLabel(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"} finished this lesson`;
}

export function LessonOfTheWeekCard({ lesson, completedParticipants }: LessonCardData): ReactNode {
  return (
    <section
      aria-label="Lesson of the week"
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
    >
      <p className="text-sm font-bold text-primary">Lesson of the week</p>
      <div className="mt-3 grid gap-5 sm:grid-cols-[14rem_1fr]">
        <img
          alt={`Poster for ${lesson.title}`}
          className="aspect-video w-full rounded-xl object-cover"
          loading="lazy"
          src={lesson.posterUrl}
        />
        <div>
          <h2 className="text-xl font-bold">{lesson.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {lesson.seriesTitle} · {formatLessonDuration(lesson.durationSeconds)}
          </p>
          <a
            className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground"
            href={lesson.pageUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Watch
          </a>
          {completedParticipants === undefined ? null : (
            <p className="mt-3 text-sm font-semibold">{completedLabel(completedParticipants)}</p>
          )}
        </div>
      </div>
      <ol aria-label="Lesson questions" className="mt-5 space-y-4">
        {lesson.quiz.map((item) => (
          <li className="rounded-xl border border-border p-4" key={item.id}>
            <p className="font-semibold">{item.prompt}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {item.choices.map((choice) => (
                <li key={choice}>{choice}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm">
              <span className="font-semibold">Got it: </span>
              {item.feedback.correct}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-semibold">Try again: </span>
              {item.feedback.wrong}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
