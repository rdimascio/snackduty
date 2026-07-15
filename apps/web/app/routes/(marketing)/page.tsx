import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import { ButtonLink } from "../../components/ui/button";

function WeekPreview(): ReactNode {
  return (
    <div
      aria-label="A simple week for the Tigers"
      className="relative rounded-3xl border border-border bg-card p-5 shadow-xl sm:p-7"
    >
      <div className="flex items-center justify-between border-b border-border pb-5">
        <div>
          <p className="text-sm text-muted-foreground">This week</p>
          <h2 className="text-2xl font-bold">Tigers</h2>
        </div>
        <span className="rounded-full bg-accent px-3 py-1 text-xs font-bold">T-Ball</span>
      </div>
      <div className="mt-5 space-y-3">
        <article className="rounded-2xl bg-muted p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            Tuesday · 5:00 PM
          </p>
          <h3 className="mt-1 font-bold">Practice at Oak Field</h3>
          <p className="mt-1 text-sm text-muted-foreground">Coach Mia · Field 2</p>
        </article>
        <article className="rounded-2xl border border-primary/20 bg-accent p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            Saturday · 9:00 AM
          </p>
          <h3 className="mt-1 font-bold">Game day + orange slices</h3>
          <p className="mt-1 text-sm text-muted-foreground">The Chen family has snacks covered</p>
        </article>
      </div>
    </div>
  );
}

function Hero(): ReactNode {
  return (
    <section className="overflow-hidden bg-hero-grid">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-8 lg:py-28">
        <div className="self-center">
          <p className="mb-5 inline-flex rounded-full border border-primary/20 bg-accent px-4 py-2 text-sm font-bold text-accent-foreground">
            Youth sports, minus the chaos
          </p>
          <h1 className="max-w-3xl text-5xl font-black leading-[1.02] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
            Don&apos;t forget <span className="text-primary">snack day.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
            One calm place for rosters, schedules, volunteers, team updates, and the little jobs
            that keep every season moving.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/app">See the team dashboard</ButtonLink>
            <ButtonLink href="/features" variant="secondary">
              Explore features
            </ButtonLink>
          </div>
        </div>
        <WeekPreview />
      </div>
    </section>
  );
}

function MadeForTeams(): ReactNode {
  return (
    <section aria-labelledby="made-for-title" className="mx-auto max-w-7xl px-5 py-20 lg:px-8">
      <h2 className="text-3xl font-black tracking-tight sm:text-4xl" id="made-for-title">
        Made for real team life.
      </h2>
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {[
          [
            "Families first",
            "Connect guardians directly to a team without pretending every child needs an account.",
          ],
          [
            "Everyone pitches in",
            "Coordinate snacks, scorekeeping, field setup, and the roles your team actually needs.",
          ],
          [
            "The schedule travels",
            "Keep practices, games, and team duties together and ready for calendar workflows.",
          ],
        ].map(([title, copy]) => (
          <article className="rounded-2xl border border-border bg-card p-6 shadow-sm" key={title}>
            <h3 className="text-xl font-bold">{title}</h3>
            <p className="mt-3 leading-7 text-muted-foreground">{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HomePage(): ReactNode {
  return (
    <>
      <Hero />
      <MadeForTeams />
    </>
  );
}

const page: PageDef<"/"> = {
  component: HomePage,
  metadata: () => ({
    title: "Snackday — youth sports, minus the chaos",
    description:
      "Simple team schedules, rosters, volunteer duties, and snack coordination for youth sports families.",
    links: [{ rel: "canonical", href: "/" }],
  }),
};

export default page;
