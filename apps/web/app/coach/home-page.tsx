import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import { COACH_ARTICLES_PATH } from "./articles";
import {
  COACH_BOOK_PATH,
  COACH_LEARN_URL,
  coachTitle,
  lessonTypes,
  playerAgeRange,
} from "./content";

export { COACH_LEARN_URL, coachTitle, lessonTypes } from "./content";

export const coachTagline = "Private baseball lessons in Orange County.";

function Intro(): ReactNode {
  return (
    <section>
      <p className="text-sm font-bold tracking-[0.2em] text-clay uppercase">Coach Ryan</p>
      <h1 className="mt-4 font-display text-6xl font-extrabold uppercase leading-[0.9] tracking-tight sm:text-7xl lg:text-8xl">
        {coachTitle}
      </h1>
      <p className="mt-6 max-w-xl text-xl text-muted sm:text-2xl">{coachTagline}</p>
      <p className="mt-4 max-w-xl text-base text-muted">
        {`Ages ${playerAgeRange}. Lessons at a park or field near you.`}
      </p>
      <a
        className="mt-8 inline-flex min-h-11 items-center justify-center rounded-lg bg-clay px-6 py-2 text-sm font-bold tracking-[0.2em] text-ink uppercase transition-colors hover:bg-clay/90"
        href={COACH_BOOK_PATH}
      >
        Request a lesson
      </a>
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
              <li className="rounded-lg border border-line p-6" key={lesson.id}>
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

        <section aria-labelledby="parents-heading" className="mt-20">
          <h2
            className="font-display text-3xl font-bold uppercase tracking-tight"
            id="parents-heading"
          >
            For parents
          </h2>
          <p className="mt-4 max-w-xl text-muted">
            Short guides on gear, first seasons, and simple drills you can do together at home.
          </p>
          <a
            className="mt-8 inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-6 py-2 text-sm font-bold tracking-[0.2em] uppercase"
            href={COACH_ARTICLES_PATH}
          >
            Read the guides
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
