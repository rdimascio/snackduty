import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import { PlayerCard } from "./player-card";
import { samplePlayer } from "./sample-player";

export const tagline = "Train like a ballplayer.";

function BallplayerHome(): ReactNode {
  return (
    <div className="hero-glow min-h-dvh bg-field text-chalk" data-app-shell data-brand="ballplayer">
      <main
        className="mx-auto grid min-h-dvh max-w-6xl items-center gap-16 px-6 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-10"
        id="main-content"
      >
        <section>
          <h1 className="font-display text-7xl font-extrabold uppercase leading-[0.9] tracking-tight sm:text-8xl lg:text-9xl">
            Ballplayer
          </h1>
          <p className="mt-6 max-w-md text-xl text-muted sm:text-2xl">{tagline}</p>
        </section>
        <div className="flex justify-center lg:justify-end">
          <PlayerCard player={samplePlayer} />
        </div>
      </main>
    </div>
  );
}

export const ballplayerHome: PageDef<"/"> = {
  component: BallplayerHome,
  metadata: () => ({
    title: "Ballplayer",
    description: tagline,
    links: [{ rel: "canonical", href: "/" }],
  }),
};
