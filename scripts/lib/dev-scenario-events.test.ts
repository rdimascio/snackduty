import { describe, expect, it } from "bun:test";

import { startDevScenario } from "./dev-scenario";
import {
  DevScenarioEventApi,
  FAMILY_EVENT_DUTY,
  FAMILY_EVENT_TITLE,
  GAME_DUTIES,
  PRACTICE_LOCATION,
  PRACTICE_SNACK_SLOTS,
  PRACTICE_TITLE,
  RSVP_EVENTS,
  SEEDED_DUTY_WINDOW_MS,
  SCENARIO_GAMES,
  countScenarioEvents,
  dutyWindow,
  scenarioEventPlan,
  upcomingScheduled,
  upcomingWeekdays,
} from "./dev-scenario-events";
import type { ScenarioEventCounts } from "./dev-scenario-events";
import type { DevScenarioManifest } from "./dev-scenario-seed";

const SATURDAY = 6;
const SEASON = {
  startDate: "2026-09-27",
  endDate: "2027-02-24",
  timeZone: "America/Los_Angeles",
} as const;

describe("scenario event plan", () => {
  const nowMs = Date.UTC(2026, 9, 27, 17);
  const plan = scenarioEventPlan(nowMs, SEASON);

  it("schedules Tuesday and Thursday practices across the whole season", () => {
    expect(plan.practice).toEqual({
      title: PRACTICE_TITLE,
      kind: "practice",
      location: PRACTICE_LOCATION,
      schedule: {
        timeZone: SEASON.timeZone,
        localTime: "17:30",
        durationMinutes: 75,
        frequency: "weekly",
        byWeekday: ["tuesday", "thursday"],
        startDate: SEASON.startDate,
        untilDate: SEASON.endDate,
      },
    });
  });

  it("places four 90-minute games on the next four Saturdays with one cancelled", () => {
    expect(plan.games.map((game) => game.input.schedule.startDate)).toEqual([
      "2026-10-31",
      "2026-11-07",
      "2026-11-14",
      "2026-11-21",
    ]);
    expect(plan.games.every((game) => game.input.schedule.localTime === "09:00")).toBe(true);
    expect(plan.games.every((game) => game.input.schedule.durationMinutes === 90)).toBe(true);
    expect(plan.games.every((game) => /\((?:home|away)\)$/u.test(game.title))).toBe(true);
    expect(plan.games.filter((game) => game.cancelledReason !== undefined)).toHaveLength(1);
  });

  it("gives the family season one Sunday event with a Snacks slot", () => {
    expect(plan.familyEvent.title).toBe(FAMILY_EVENT_TITLE);
    expect(plan.familyEvent.schedule.startDate).toBe("2026-11-01");
    expect(plan.familyEvent.snackDuty).toEqual({ label: FAMILY_EVENT_DUTY });
  });

  it("never schedules a game for today, even on a Saturday", () => {
    expect(upcomingWeekdays("2026-10-31", SATURDAY, 2)).toEqual(["2026-11-07", "2026-11-14"]);
  });
});

const REFUSED_PROXY = "http://127.0.0.1:9";
const OFFLINE_SERVER_ENV = {
  HTTP_PROXY: REFUSED_PROXY,
  HTTPS_PROXY: REFUSED_PROXY,
  http_proxy: REFUSED_PROXY,
  https_proxy: REFUSED_PROXY,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

interface ScenarioTotals {
  readonly teams: number;
  readonly coachedRoster: number;
  readonly coached: ScenarioEventCounts;
  readonly family: ScenarioEventCounts;
}

async function totals(
  api: DevScenarioEventApi,
  cookie: string,
  manifest: DevScenarioManifest,
  seededAtMs: number,
): Promise<ScenarioTotals> {
  const { coached, family } = manifest.teams;
  const { teams = [] } = await api.listTeams(cookie);
  return {
    teams: teams.length,
    coachedRoster: (await api.readSeasonRoster(cookie, coached.teamId, coached.seasonId)).length,
    coached: await countScenarioEvents(
      api,
      cookie,
      coached,
      dutyWindow(seededAtMs, SEEDED_DUTY_WINDOW_MS),
    ),
    family: await countScenarioEvents(
      api,
      cookie,
      family,
      dutyWindow(seededAtMs, SEEDED_DUTY_WINDOW_MS),
    ),
  };
}

async function page(baseUrl: string, cookie: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return response.text();
}

describe("seeded schedule and duties", () => {
  it("seeds the events and renders them on /app/schedule and /app/duties for both personas", async () => {
    const startedAtMs = Date.now();
    const running = await startDevScenario({ serverEnv: OFFLINE_SERVER_ENV });
    try {
      const { manifest } = running;
      const baseUrl = manifest.webBaseUrl;
      const api = new DevScenarioEventApi(baseUrl);
      const owner = await api.signIn("default");
      const parent = await api.signIn("second-adult");

      const first = await totals(api, owner.cookie, manifest, startedAtMs);
      expect(first.teams).toBe(2);
      expect(first.coachedRoster).toBe(3);
      expect(first.coached.series).toBe(SCENARIO_GAMES.length + 1);
      expect(first.coached.cancelled).toBe(1);
      expect(first.coached.claimedSlots).toBe(6);
      expect(first.coached.dutySlots).toBe(
        PRACTICE_SNACK_SLOTS + GAME_DUTIES.length * (SCENARIO_GAMES.length - 1),
      );
      expect(first.coached.rsvps).toBe(4);
      expect(first.family).toMatchObject({ series: 1, occurrences: 1, dutySlots: 1, rsvps: 1 });
      expect(first.family.claimedSlots).toBe(0);

      const { coached, family } = manifest.teams;
      const coachedOccurrences = (
        await api.listSeasonEvents(owner.cookie, coached.teamId, coached.seasonId)
      ).flatMap((entry) => entry.occurrences);
      const firstUpcoming = upcomingScheduled(coachedOccurrences, startedAtMs)
        .slice(0, RSVP_EVENTS)
        .map((occurrence) => occurrence.id);
      const answered = coachedOccurrences
        .filter(({ attendance }) => attendance.yes + attendance.no + attendance.maybe > 0)
        .map((occurrence) => occurrence.id);
      expect(firstUpcoming).toHaveLength(RSVP_EVENTS);
      expect(answered.toSorted()).toEqual(firstUpcoming.toSorted());

      const coachedQuery = `?team=${coached.teamId}&season=${coached.seasonId}`;
      for (const cookie of [owner.cookie, parent.cookie]) {
        const schedule = await page(baseUrl, cookie, `/app/schedule${coachedQuery}`);
        for (const game of SCENARIO_GAMES) expect(schedule).toContain(game.title);
        expect(schedule).toContain(PRACTICE_TITLE);
        expect(schedule).toContain(PRACTICE_LOCATION);
        expect(schedule).toContain("Field closed after heavy rain");

        const duties = await page(baseUrl, cookie, `/app/duties${coachedQuery}`);
        expect(duties).toContain(SCENARIO_GAMES[0]?.title ?? "");
        for (const label of GAME_DUTIES) expect(duties).toContain(label);
        expect(duties).toContain(owner.displayName);
        expect(duties).toContain(parent.displayName);
      }
      const familyDuties = await page(
        baseUrl,
        parent.cookie,
        `/app/duties?team=${family.teamId}&season=${family.seasonId}`,
      );
      expect(familyDuties).toContain(FAMILY_EVENT_TITLE);
      expect(familyDuties).toContain(FAMILY_EVENT_DUTY);
    } finally {
      await running.stop();
    }
  }, 120_000);
});
