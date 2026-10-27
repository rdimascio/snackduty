import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { AppNavigationLinks, sectionForPath } from "../team/navigation";

function TeamNavigation(): ReactNode {
  const current = sectionForPath(globalThis.location?.pathname ?? "");
  return <AppNavigationLinks {...(current === undefined ? {} : { current })} />;
}

function TeamNavigationFallback(): ReactNode {
  return <AppNavigationLinks />;
}

export default defineIsland({
  component: TeamNavigation,
  fallback: TeamNavigationFallback,
  name: "TeamNavigation",
});
