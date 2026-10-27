import type { ReactNode } from "react";

import { notFound } from "@lesto/web";
import type { Context, PageDef, PageProps } from "@lesto/web";

import { EmptyState } from "../../../components/states/empty-state";
import { ButtonLink } from "../../../components/ui/button";
import { loadDutiesPage } from "../../../duties/duties-data";
import type { DutiesPageData, SeasonChoice } from "../../../duties/duties-data";
import DutiesBoardIsland from "../../../islands/duties-board";
import { appServices } from "../../../lib/server/app-services";

function selectionValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

const load = (c: Context<"/app/duties">): Promise<DutiesPageData> => {
  const teamId = selectionValue(c.query("team"));
  const seasonId = selectionValue(c.query("season"));
  return loadDutiesPage(appServices(c), c.header("cookie"), {
    ...(teamId === undefined ? {} : { teamId }),
    ...(seasonId === undefined ? {} : { seasonId }),
  });
};

function DutiesIntro({ title, lede }: { title: string; lede: string }): ReactNode {
  return (
    <div>
      <p className="text-sm font-bold text-primary">Duties</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-muted-foreground">{lede}</p>
    </div>
  );
}

function SeasonSwitcher({ choices }: { choices: readonly SeasonChoice[] }): ReactNode {
  if (choices.length === 0) return null;
  return (
    <nav aria-label="Team and season" className="mt-4 flex flex-wrap gap-2">
      {choices.map((choice) => (
        <a
          aria-current={choice.current ? "page" : undefined}
          className={
            choice.current
              ? "rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-full border border-border bg-card px-3 py-1.5 text-sm font-semibold hover:bg-muted"
          }
          href={choice.href}
          key={choice.href}
        >
          {choice.label}
        </a>
      ))}
    </nav>
  );
}

function Duties(data: PageProps<typeof load>): ReactNode {
  if (data.state === "not-found") notFound();

  if (data.state === "signed-out") {
    return (
      <div>
        <DutiesIntro
          lede="Sign in to see who brings snacks and which slots are still open."
          title="Snack duty"
        />
        <div className="mt-8">
          <EmptyState
            description="Duty lists name the adults on a team, so nothing is shown until you sign in."
            title="Signed out"
          />
        </div>
      </div>
    );
  }

  if (data.state === "no-team") {
    return (
      <div>
        <DutiesIntro lede="You are signed in, but you are not on a team yet." title="Snack duty" />
        <div className="mt-8">
          <EmptyState
            action={<ButtonLink href="/app">Go to overview</ButtonLink>}
            description="Join a team from an invitation, or create one, and its duties will appear here."
            title="No team yet"
          />
        </div>
      </div>
    );
  }

  if (data.state === "no-season") {
    return (
      <div>
        <DutiesIntro lede="No season yet" title={data.teamName} />
        <div className="mt-8">
          <EmptyState
            description="Duties attach to the events of a season. Once the team has a season with events, they appear here."
            title="No season yet"
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <DutiesIntro
        lede={`${data.seasonLabel} · Snacks and other jobs for every upcoming event`}
        title={data.teamName}
      />
      <SeasonSwitcher choices={data.choices} />
      <div className="mt-8">
        {data.board.occurrences.length === 0 ? (
          <EmptyState
            description={
              data.board.canManage
                ? "Add events to this season's schedule, then add a duty slot to each one."
                : "When the coach schedules events with duties, they appear here for you to claim."
            }
            title="No upcoming events"
          />
        ) : (
          <DutiesBoardIsland {...data.board} />
        )}
      </div>
    </div>
  );
}

const page: PageDef<"/app/duties", DutiesPageData> = {
  component: Duties,
  load,
  metadata: () => ({
    title: "Duties — Snackday",
    description: "Snack duty and other team jobs for every upcoming event.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
