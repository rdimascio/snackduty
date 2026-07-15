import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import { EmptyState } from "../../components/states/empty-state";
import { ButtonLink } from "../../components/ui/button";

const page: PageDef<"/app"> = {
  component: (): ReactNode => (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold text-primary">Welcome to Snackday</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
            Your team, at a glance
          </h1>
          <p className="mt-2 text-muted-foreground">
            Once identity and team setup land, this workspace will reflect your real season.
          </p>
        </div>
        <ButtonLink href="/features" variant="secondary">
          View what&apos;s coming
        </ButtonLink>
      </div>
      <section aria-label="Team summary" className="mt-8 grid gap-4 sm:grid-cols-3">
        {[
          ["Next event", "Nothing scheduled"],
          ["Open duties", "All clear"],
          ["Team members", "Ready for setup"],
        ].map(([label, value]) => (
          <article className="rounded-2xl border border-border bg-card p-5 shadow-sm" key={label}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-xl font-bold">{value}</p>
          </article>
        ))}
      </section>
      <div className="mt-8">
        <EmptyState
          title="No upcoming events"
          description="When your team schedule is connected, practices and games will appear here with the duties that keep them running."
        />
      </div>
    </div>
  ),
  metadata: () => ({
    title: "Team overview — Snackday",
    description: "Your Snackday team workspace for schedules, members, and shared duties.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
