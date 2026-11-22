import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

export const coachTitle = "DiMascio Baseball";

export const coachTagline = "Private baseball lessons in Orange County.";

export const COACH_LEARN_URL = "https://learn.dimasciobaseball.com/";

interface LessonType {
  readonly name: string;
  readonly who: string;
  readonly detail: string;
}

export const lessonTypes: readonly LessonType[] = [
  {
    name: "Private lesson",
    who: "One player",
    detail: "Hitting, throwing, fielding or catching, built around what your player needs next.",
  },
  {
    name: "Small group",
    who: "Two to four players",
    detail: "Siblings or teammates train together. Good reps, and a little friendly competition.",
  },
  {
    name: "Team clinic",
    who: "A whole team",
    detail: "A practice plan and a run clinic for your rec or travel team, at your field.",
  },
];

function Intro(): ReactNode {
  return (
    <section>
      <p className="text-sm font-bold tracking-[0.2em] text-clay uppercase">Coach Ryan</p>
      <h1 className="mt-4 font-display text-6xl font-extrabold uppercase leading-[0.9] tracking-tight sm:text-7xl lg:text-8xl">
        {coachTitle}
      </h1>
      <p className="mt-6 max-w-xl text-xl text-muted sm:text-2xl">{coachTagline}</p>
      <p className="mt-4 max-w-xl text-base text-muted">
        Ages 5 to 14. Lessons at a park or field near you. Booking opens soon.
      </p>
    </section>
  );
}

function CoachHome(): ReactNode {
  return (
    <div className="min-h-dvh bg-field text-chalk" data-app-shell data-brand="coach">
      <main className="mx-auto max-w-5xl px-6 py-20 lg:px-10" id="main-content">
        <Intro />

        <section aria-labelledby="lessons-heading" className="mt-20">
          <h2
            className="font-display text-3xl font-bold uppercase tracking-tight"
            id="lessons-heading"
          >
            Lessons
          </h2>
          <ul className="mt-8 grid gap-6 sm:grid-cols-3">
            {lessonTypes.map((lesson) => (
              <li className="rounded-lg border border-line p-6" key={lesson.name}>
                <h3 className="text-lg font-bold">{lesson.name}</h3>
                <p className="mt-1 text-sm text-clay">{lesson.who}</p>
                <p className="mt-4 text-sm text-muted">{lesson.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="learn-heading" className="mt-20">
          <h2
            className="font-display text-3xl font-bold uppercase tracking-tight"
            id="learn-heading"
          >
            Learn with Coach Blooper
          </h2>
          <p className="mt-4 max-w-xl text-muted">
            Short cartoon lessons for young players. Watch one together before practice.
          </p>
          <a
            className="mt-8 inline-flex min-h-11 items-center justify-center rounded-lg bg-clay px-6 py-2 text-sm font-bold tracking-[0.2em] text-ink uppercase transition-colors hover:bg-clay/90"
            href={COACH_LEARN_URL}
          >
            Watch episodes
          </a>
        </section>
      </main>
    </div>
  );
}

export const coachHome: PageDef<"/"> = {
  component: CoachHome,
  metadata: () => ({
    title: coachTitle,
    description: coachTagline,
    links: [{ rel: "canonical", href: "/" }],
  }),
};
