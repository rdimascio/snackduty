import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { Card } from "@snackday/skill-engine";
import { describe, expect, it } from "vitest";

import { ballplayerApp } from "../app/ballplayer/app-page";
import type { BallplayerAppData } from "../app/ballplayer/app-data";
import { PlayerCard } from "../app/ballplayer/player-card";
import {
  ballplayerAreas,
  ballplayerCard,
  currentStreak,
  LIVE_STREAK_WINDOW_MS,
} from "../app/ballplayer/real-player";
import type { ReadablePlayer } from "../app/ballplayer/real-player";
import { hasInlineStyle } from "./support/third-party";

const NOW = Date.UTC(2026, 9, 26, 19);
const HOUR_MS = 60 * 60 * 1_000;

function skill(id: string, lastTrainedMs: number, streakAtLast: number): Card["skills"][number] {
  return {
    skill: id,
    rating: 10,
    points: 6,
    drills: 3,
    lastTrainedAt: new Date(lastTrainedMs).toISOString(),
    streakAtLast,
  };
}

const card: Card = {
  skills: [
    skill("infield.ready-position", NOW - 3 * HOUR_MS, 7),
    skill("baserunning.out-of-the-box", NOW - 30 * HOUR_MS, 6),
  ],
  areas: [
    { area: "hitting", rating: 9 },
    { area: "bunting", rating: 4 },
    { area: "baserunning", rating: 18 },
    { area: "infield", rating: 20 },
    { area: "outfield", rating: 5 },
    { area: "pitching", rating: 3 },
    { area: "baseball-iq", rating: 7 },
    { area: "mental", rating: 0 },
  ],
  overall: 8,
  explain: [],
};

function player(viewer: ReadablePlayer["viewer"], value: Card = card): ReadablePlayer {
  return {
    participantId: "participant-1",
    label: "Casey Kid",
    teamName: "Coach Pitch Comets",
    viewer,
    card: value,
  };
}

function renderPage(data: BallplayerAppData): string {
  return render(createElement(ballplayerApp.component, data));
}

describe("ballplayerAreas", () => {
  it("folds the Little League areas into the five card areas by floored mean", () => {
    expect(ballplayerAreas(card)).toEqual([
      { area: "Hitting", short: "HIT", rating: 6 },
      { area: "Fielding", short: "FLD", rating: 12 },
      { area: "Throwing", short: "THR", rating: 3 },
      { area: "Speed", short: "SPD", rating: 18 },
      { area: "Baseball IQ", short: "IQ", rating: 3 },
    ]);
  });

  it("leaves out a card area with no rated source area", () => {
    const pitchingOnly: Card = { ...card, areas: [{ area: "pitching", rating: 40 }] };

    expect(ballplayerAreas(pitchingOnly)).toEqual([{ area: "Throwing", short: "THR", rating: 40 }]);
  });
});

describe("currentStreak", () => {
  it("reads the streak of the most recent training with its multiplier", () => {
    expect(currentStreak(card, NOW)).toEqual({ days: 7, multiplier: "1.5x" });
  });

  it("drops the multiplier while the streak earns no bonus", () => {
    const short: Card = { ...card, skills: [skill("infield.ready-position", NOW - HOUR_MS, 2)] };

    expect(currentStreak(short, NOW)).toEqual({ days: 2 });
  });

  it("hides a streak whose last training is older than the live window", () => {
    expect(currentStreak(card, NOW - 3 * HOUR_MS + LIVE_STREAK_WINDOW_MS)).toEqual({
      days: 7,
      multiplier: "1.5x",
    });
    expect(currentStreak(card, NOW - 3 * HOUR_MS + LIVE_STREAK_WINDOW_MS + 1)).toBeUndefined();
  });

  it("hides the streak for a card with no training or no streak", () => {
    expect(currentStreak({ ...card, skills: [] }, NOW)).toBeUndefined();
    expect(
      currentStreak({ ...card, skills: [skill("mental.failure", NOW - HOUR_MS, 0)] }, NOW),
    ).toBeUndefined();
  });
});

describe("ballplayerCard", () => {
  it("labels a guardian's card as their player and a coach's card as read only", () => {
    expect(ballplayerCard(player("guardian"), NOW).caption).toBe(
      "Coach Pitch Comets · Your player",
    );
    expect(ballplayerCard(player("coach"), NOW).caption).toBe(
      "Coach Pitch Comets · Coach view · Read only",
    );
  });

  it("renders the real overall and hides the parts the skill card does not carry", () => {
    const html = render(
      createElement(PlayerCard, { player: ballplayerCard(player("guardian"), NOW) }),
    );

    expect(html).toContain('aria-label="Player card for Casey Kid"');
    expect(html).toContain("player-card tier-rookie");
    expect(html).toContain(">8<");
    expect(html).toContain("7-day streak");
    expect(html).not.toContain("Next 9");
    expect(html).not.toContain("jersey-number");
    expect(html).not.toContain("B/T");
    expect(html).not.toContain("Sample card");
    expect(hasInlineStyle(html)).toBe(false);
  });

  it("renders no footer when the streak is not live", () => {
    const html = render(
      createElement(PlayerCard, {
        player: ballplayerCard(player("guardian"), NOW + 3 * 24 * HOUR_MS),
      }),
    );

    expect(html).not.toContain("<footer");
    expect(html).not.toContain("streak");
  });
});

describe("the Ballplayer /app page states", () => {
  it("shows the server without data as unavailable", () => {
    expect(renderPage({ state: "unavailable" })).toContain("No player data");
  });

  it("says web sign-in is not available when the server has no dev sign-in", () => {
    const html = renderPage({ state: "signed-out", devSignIn: false });

    expect(html).toContain("Sign-in coming soon");
    expect(html).not.toContain("Development sign-in");
  });

  it("offers the dev sign-in on a development server", () => {
    const html = renderPage({ state: "signed-out", devSignIn: true });

    expect(html).toContain("Development sign-in");
    expect(html).toContain("Sign in as the second adult");
  });

  it("shows the error state with a reload link", () => {
    const html = renderPage({ state: "error", adultName: "Development Adult" });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Cards did not load");
    expect(html).toContain('href="/app"');
  });

  it("shows when player cards are turned off", () => {
    expect(renderPage({ state: "cards-off", adultName: "Development Adult" })).toContain(
      "Cards are off",
    );
  });

  it("shows the empty state for an adult with no readable cards", () => {
    const html = renderPage({ state: "empty", adultName: "Development Adult" });

    expect(html).toContain("No player cards yet");
    expect(html).toContain("Sign out");
  });

  it("declares a private, unindexed page", () => {
    expect(ballplayerApp.metadata?.({ state: "unavailable" })).toEqual({
      title: "Player cards — Ballplayer",
      description: "Your players' Ballplayer cards.",
      meta: [{ name: "robots", content: "noindex, nofollow" }],
    });
  });
});
