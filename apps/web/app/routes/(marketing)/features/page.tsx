import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

const features = [
  [
    "A roster built around families",
    "Invite guardians once, keep household relationships clear, and never require a five-year-old to manage an account.",
  ],
  [
    "Schedules that stay useful",
    "Bring practices, games, reminders, and calendar workflows into one season view.",
  ],
  [
    "Every volunteer role",
    "Make room for scorekeepers, snack families, field crews, photographers, and whatever your league calls them.",
  ],
  [
    "Snack duty without the group-text spiral",
    "Assign, remind, and make swaps visible so everyone knows what is covered.",
  ],
  [
    "Signatures in one place",
    "Give organizers a clear home for the forms and acknowledgements a season requires.",
  ],
  [
    "Memories for the team",
    "Share team photos with privacy-aware access designed around the people who belong there.",
  ],
] as const;

const page: PageDef<"/features"> = {
  component: (): ReactNode => (
    <div className="mx-auto max-w-7xl px-5 py-20 lg:px-8">
      <div className="max-w-3xl">
        <p className="text-sm font-bold uppercase tracking-widest text-primary">What teams need</p>
        <h1 className="mt-4 text-5xl font-black tracking-[-0.04em] sm:text-6xl">
          Less admin. More playing.
        </h1>
        <p className="mt-6 text-xl leading-8 text-muted-foreground">
          Snackday focuses on the work recreational teams do every week—not a pile of features built
          for recruiting.
        </p>
      </div>
      <section
        aria-label="Snackday features"
        className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3"
      >
        {features.map(([title, description], index) => (
          <article className="rounded-2xl border border-border bg-card p-6 shadow-sm" key={title}>
            <span aria-hidden="true" className="text-sm font-black text-primary">
              0{index + 1}
            </span>
            <h2 className="mt-4 text-xl font-bold">{title}</h2>
            <p className="mt-3 leading-7 text-muted-foreground">{description}</p>
          </article>
        ))}
      </section>
    </div>
  ),
  metadata: () => ({
    title: "Features for youth sports teams — Snackday",
    description:
      "Family-friendly rosters, schedules, volunteer duties, snack coordination, signatures, and team memories.",
    links: [{ rel: "canonical", href: "/features" }],
  }),
};

export default page;
