import type { Context, PageDef } from "@lesto/web";

import { appServices } from "../../../lib/server/app-services";
import { lessonServicesFrom } from "../../../lessons/lessons";
import { loadRosterPage } from "../../../roster/roster-data";
import type { RosterPageData } from "../../../roster/roster-data";
import { RosterPage } from "../../../roster/roster-view";

const load = async (c: Context<"/app/roster">): Promise<RosterPageData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };
  const data = await loadRosterPage(
    services,
    c.header("cookie"),
    { teamId: c.query("team"), seasonId: c.query("season") },
    lessonServicesFrom(c) !== undefined,
  );
  if (data.state === "not-found") c.status(404);
  return data;
};

const page: PageDef<"/app/roster", RosterPageData> = {
  component: RosterPage,
  load,
  metadata: () => ({
    title: "Roster — Snackday",
    description: "Your team's players, their guardians, and invitation status.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
