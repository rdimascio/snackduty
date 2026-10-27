import type { ReactNode } from "react";

import type { Context, PageProps } from "@lesto/web";

import BallplayerSessionIsland from "../islands/ballplayer-session";
import { lessonServicesFrom } from "../lessons/lessons";
import { appServices } from "../lib/server/app-services";
import { authenticatedAdult } from "../lib/server/identity";
import { PlayerCard } from "./player-card";
import { ballplayerCard } from "./real-player";
import { loadReadablePlayers } from "./readable-players";
import type {
  BallplayerAppData,
  BallplayerAppPage,
  BallplayerAppPath,
  BallplayerCardEntry,
} from "./app-data";

const load = async (c: Context<BallplayerAppPath>): Promise<BallplayerAppData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "unavailable" };
  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) {
    return { state: "signed-out", devSignIn: services.sessions.mode === "development" };
  }
  const adultName = identity.person.displayName;
  if (lessonServicesFrom(c) === undefined) return { state: "cards-off", adultName };
  try {
    const players = await loadReadablePlayers(services.db, identity.person.id);
    if (players.length === 0) return { state: "empty", adultName };
    const now = services.clock();
    return {
      state: "cards",
      adultName,
      cards: players.map((player) => ({
        participantId: player.participantId,
        ...ballplayerCard(player, now),
      })),
      readOnly: players.some((player) => player.viewer === "coach"),
    };
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "ballplayer.player_cards_unavailable" }));
    return { state: "error", adultName };
  }
};

function Shell({ aside, children }: { aside?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="hero-glow min-h-dvh bg-field text-chalk" data-app-shell data-brand="ballplayer">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 pt-8 lg:px-10">
        <a
          className="font-display text-3xl font-extrabold tracking-tight uppercase"
          href="/"
          aria-label="Ballplayer home"
        >
          Ballplayer
        </a>
        {aside}
      </header>
      <main className="mx-auto max-w-6xl px-6 pt-10 pb-20 lg:px-10" id="main-content">
        {children}
      </main>
    </div>
  );
}

function Intro({ eyebrow, title, lede }: { eyebrow: string; title: string; lede: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-bold tracking-[0.3em] text-clay uppercase">{eyebrow}</p>
      <h1 className="mt-2 font-display text-5xl leading-[0.95] font-extrabold tracking-tight uppercase sm:text-6xl">
        {title}
      </h1>
      <p className="mt-4 text-lg text-muted">{lede}</p>
    </div>
  );
}

function Panel({
  role,
  title,
  description,
  children,
}: {
  role?: "alert" | "status";
  title: string;
  description: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <section
      className="mt-10 max-w-xl rounded-2xl border border-line bg-black/20 p-6 sm:p-8"
      role={role}
    >
      <h2 className="font-display text-2xl font-extrabold tracking-wide uppercase">{title}</h2>
      <p className="mt-2 leading-7 text-muted">{description}</p>
      {children === undefined ? null : <div className="mt-6">{children}</div>}
    </section>
  );
}

function SignedOut({ devSignIn }: { devSignIn: boolean }): ReactNode {
  return (
    <Shell>
      <Intro
        eyebrow="Sign in"
        lede="Sign in to see the player cards for your children, and for your roster if you coach."
        title="Your player cards"
      />
      {devSignIn ? (
        <Panel
          description="This is a development server. Pick a development adult to start a session on this host."
          title="Development sign-in"
        >
          <BallplayerSessionIsland action="sign-in" />
        </Panel>
      ) : (
        <Panel
          description="Web sign-in is not available on this server yet. Player cards are private to their signed-in adults, so nothing shows until you sign in."
          role="status"
          title="Sign-in coming soon"
        />
      )}
    </Shell>
  );
}

function SignedIn({ adultName, children }: { adultName: string; children: ReactNode }) {
  return (
    <Shell
      aside={
        <div className="flex items-center gap-4">
          <p className="hidden text-sm text-muted sm:block">
            Signed in as <span className="font-semibold text-chalk">{adultName}</span>
          </p>
          <BallplayerSessionIsland action="sign-out" />
        </div>
      }
    >
      {children}
    </Shell>
  );
}

const CARDS_LEDE =
  "Ratings come from the drills, lessons and checks your players finish. The card tier follows the overall.";

function CardGrid({
  cards,
  readOnly,
}: {
  cards: readonly BallplayerCardEntry[];
  readOnly: boolean;
}): ReactNode {
  return (
    <>
      {readOnly ? (
        <p className="mt-6 text-sm text-muted">
          Cards for players you coach are read only. Only a player&apos;s guardian can add to their
          card.
        </p>
      ) : null}
      <ul
        aria-label="Player cards"
        className="mt-10 grid justify-items-center gap-10 md:grid-cols-2 xl:grid-cols-3"
      >
        {cards.map((card) => (
          <li className="flex w-full justify-center" key={card.participantId}>
            <PlayerCard player={card} />
          </li>
        ))}
      </ul>
    </>
  );
}

function BallplayerApp(data: PageProps<typeof load>): ReactNode {
  if (data.state === "unavailable") {
    return (
      <Shell>
        <Intro
          eyebrow="Player cards"
          lede="Player cards load from the Ballplayer app server."
          title="Not available here"
        />
        <Panel
          description="This server has no player data. Open Ballplayer on its main site to see your cards."
          role="status"
          title="No player data"
        />
      </Shell>
    );
  }
  if (data.state === "signed-out") return <SignedOut devSignIn={data.devSignIn} />;

  const intro = <Intro eyebrow="Player cards" lede={CARDS_LEDE} title="Your players" />;
  return (
    <SignedIn adultName={data.adultName}>
      {intro}
      {data.state === "cards-off" ? (
        <Panel
          description="Player cards are turned off on this server."
          role="status"
          title="Cards are off"
        />
      ) : null}
      {data.state === "error" ? (
        <Panel
          description="We could not load your player cards. Reload the page to try again."
          role="alert"
          title="Cards did not load"
        >
          <a className="text-sm font-semibold text-clay underline" href="/app">
            Reload player cards
          </a>
        </Panel>
      ) : null}
      {data.state === "empty" ? (
        <Panel
          description="You see a card for each child you are a guardian of, and a read-only card for each child on an active roster you coach. None are on file yet."
          role="status"
          title="No player cards yet"
        />
      ) : null}
      {data.state === "cards" ? <CardGrid cards={data.cards} readOnly={data.readOnly} /> : null}
    </SignedIn>
  );
}

export const ballplayerApp: BallplayerAppPage = {
  component: BallplayerApp,
  load,
  metadata: () => ({
    title: "Player cards — Ballplayer",
    description: "Your players' Ballplayer cards.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};
