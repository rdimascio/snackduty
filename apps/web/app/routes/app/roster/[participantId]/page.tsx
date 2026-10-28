import type { ReactNode } from "react";

import type { Context, PageDef } from "@lesto/web";

import { EmptyState } from "../../../../components/states/empty-state";
import { appServices } from "../../../../lib/server/app-services";
import { lessonServicesFrom } from "../../../../lessons/lessons";
import { loadPlayerCardPage } from "../../../../roster/player-card-data";
import type { PlayerCardPageData } from "../../../../roster/player-card-data";
import { PlayerCardList } from "../../../../skills/player-card";
import { NotFoundState } from "../../../not-found";

const load = async (c: Context<"/app/roster/:participantId">): Promise<PlayerCardPageData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };
  const data = await loadPlayerCardPage(services, lessonServicesFrom(c), c.header("cookie"), {
    teamId: c.query("team"),
    seasonId: c.query("season"),
    participantId: c.param("participantId"),
  });
  if (data.state === "not-found") c.status(404);
  return data;
};

function PlayerCardPage(data: PlayerCardPageData): ReactNode {
  if (data.state === "not-found") return <NotFoundState />;
  if (data.state === "signed-out") {
    return (
      <div>
        <p className="text-sm font-bold text-primary">Player card</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">Player card</h1>
        <div className="mt-8">
          <EmptyState
            description="Player cards are private to a child's guardians and coaches, so nothing is shown until you sign in."
            title="Signed out"
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <a
        className="text-sm font-semibold text-muted-foreground hover:text-foreground"
        href={data.rosterHref}
      >
        ← Back to the {data.teamName} roster
      </a>
      <p className="mt-4 text-sm font-bold text-primary">Player card</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{data.player.label}</h1>
      <p className="mt-2 text-muted-foreground">{data.teamName}</p>
      <section
        aria-label="Player card"
        className="mt-8 max-w-2xl rounded-2xl border border-border bg-card p-5 shadow-sm"
      >
        <PlayerCardList players={[data.player]} />
        {data.player.areas.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No drills or lessons are scored yet. Ratings fill in as this player trains.
          </p>
        ) : null}
      </section>
    </div>
  );
}

const page: PageDef<"/app/roster/:participantId", PlayerCardPageData> = {
  component: PlayerCardPage,
  load,
  metadata: () => ({
    title: "Player card — Snackday",
    description: "A player's skill ratings, read-only.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
