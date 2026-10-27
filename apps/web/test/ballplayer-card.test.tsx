import { existsSync, readdirSync, readFileSync } from "node:fs";

import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cardTier } from "../app/ballplayer/card-tier";
import { ballplayerHome } from "../app/ballplayer/home-page";
import { PlayerCard } from "../app/ballplayer/player-card";
import { samplePlayer } from "../app/ballplayer/sample-player";
import { findThirdPartyRisks, hasInlineStyle } from "./support/third-party";

const stylesheet = readFileSync(new URL("../app/styles/app.css", import.meta.url), "utf8");

const fontDirectory = new URL("../public/fonts/", import.meta.url);

describe("cardTier", () => {
  it.each([
    [99, "diamond"],
    [85, "diamond"],
    [84, "gold"],
    [80, "gold"],
    [79, "silver"],
    [75, "silver"],
    [74, "bronze"],
    [65, "bronze"],
    [64, "rookie"],
    [0, "rookie"],
  ] as const)("maps an overall of %i to %s", (overall, tier) => {
    expect(cardTier(overall)).toBe(tier);
  });
});

describe("PlayerCard", () => {
  it("renders the sample player as a gold card with its overall, position and streak", () => {
    const html = render(<PlayerCard player={samplePlayer} />);

    expect(html).toContain('aria-label="Player card for Sample Player"');
    expect(html).toContain("player-card tier-gold");
    expect(html).toContain(">84<");
    expect(html).toContain("OVR");
    expect(html).toContain(">SS<");
    expect(html).toContain("12-day streak");
    expect(html).toContain("Next 85");
    expect(html).toContain("Sample card · Ballplayer");
    expect(hasInlineStyle(html)).toBe(false);
  });
});

describe("the Ballplayer landing page definition", () => {
  it("declares Ballplayer metadata", () => {
    expect(ballplayerHome.metadata?.(undefined)).toEqual({
      title: "Ballplayer",
      description: "Train like a ballplayer.",
      links: [{ rel: "canonical", href: "/" }],
    });
  });
});

describe("the app stylesheet", () => {
  it("loads fonts only from this origin", () => {
    expect(stylesheet).toContain("@font-face");
    expect(findThirdPartyRisks(stylesheet, "css")).toEqual([]);
  });

  it("points every font face at a bundled font file", () => {
    const sources = [...stylesheet.matchAll(/url\("\/fonts\/([^"]+)"\)/gu)].map(
      ([, file]) => file ?? "",
    );

    expect(sources.length).toBe(3);
    for (const file of sources) {
      expect({ file, bundled: existsSync(new URL(file, fontDirectory)) }).toEqual({
        file,
        bundled: true,
      });
    }
  });

  it("ships each bundled font family with its OFL license", () => {
    const files = readdirSync(fontDirectory);

    expect(files).toContain("LICENSE-inter.txt");
    expect(files).toContain("LICENSE-barlow-condensed.txt");
    for (const license of ["LICENSE-inter.txt", "LICENSE-barlow-condensed.txt"]) {
      expect(readFileSync(new URL(license, fontDirectory), "utf8")).toContain(
        "SIL Open Font License, Version 1.1",
      );
    }
  });
});
