import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppNavigationLinks, appSections, sectionForPath } from "../app/team/navigation";

describe("sidebar sections", () => {
  it("lists the five app sections in order", () => {
    expect(appSections.map((section) => section.href)).toStrictEqual([
      "/app",
      "/app/team",
      "/app/roster",
      "/app/schedule",
      "/app/duties",
    ]);
  });

  it("maps a path to its section", () => {
    expect(sectionForPath("/app")).toBe("/app");
    expect(sectionForPath("/app/")).toBe("/app");
    expect(sectionForPath("/app/team")).toBe("/app/team");
    expect(sectionForPath("/app/roster/participant_1")).toBe("/app/roster");
    expect(sectionForPath("/app/schedule/")).toBe("/app/schedule");
    expect(sectionForPath("/app/duties")).toBe("/app/duties");
    expect(sectionForPath("/app/teams")).toBeUndefined();
    expect(sectionForPath("/invite")).toBeUndefined();
    expect(sectionForPath("")).toBeUndefined();
  });

  it("marks only the current section with aria-current", () => {
    const html = renderToStaticMarkup(createElement(AppNavigationLinks, { current: "/app/team" }));
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/app\/team"|href="\/app\/team"[^>]*aria-current="page"/u,
    );
    expect(html).not.toContain("aria-disabled");
  });

  it("marks nothing when no section matches", () => {
    const html = renderToStaticMarkup(createElement(AppNavigationLinks, {}));
    expect(html).not.toContain("aria-current");
    expect(html.match(/<a /gu)).toHaveLength(5);
  });
});
