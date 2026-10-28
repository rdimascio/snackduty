import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { SEED_SCHEDULE } from "../apps/web/app/dev/seed-personas";
import {
  CHILDREN,
  COMETS,
  FALCONS,
  OCCURRENCES,
  SERIES,
  button,
  eventPath,
  expectHtmlLacks,
  expectNoButton,
  localDatePlus,
  main,
  openFresh,
  practiceOccurrences,
  seriesEditPath,
  teamApi,
  waitForStatus,
} from "./support/pages";
import { useScenario } from "./support/scenario";
import type { Scenario } from "./support/scenario";
import { asRole, refused } from "./support/session";
import type { Role, RoleSession } from "./support/session";

setDefaultTimeout(90_000);

const SCHEDULE_PAGE = `/app/schedule?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`;
const EXPORT_PAGE = `/app/schedule/export?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`;
const NEW_EVENT_PAGE = `/app/schedule/new?team=${FALCONS.teamId}&season=${FALCONS.seasonId}`;
const CSV_HEADER = "Date,Start,End,Time zone,Event,Type,Location,Status,Cancellation reason";

const REFUSED_EVENT = {
  title: "Refused event",
  kind: "practice",
  schedule: {
    timeZone: "America/Phoenix",
    localTime: "18:00",
    durationMinutes: 60,
    frequency: "once",
    startDate: localDatePlus(3),
  },
};

function attendanceStatus(
  scenario: Scenario,
  occurrenceId: string,
  participantId: string,
): string | undefined {
  return scenario.query<{ status: string }>(
    "SELECT status FROM event_attendance WHERE occurrence_id = ? AND participant_id = ?",
    occurrenceId,
    participantId,
  )[0]?.status;
}

function occurrenceStatus(scenario: Scenario, occurrenceId: string): string | undefined {
  return scenario.query<{ status: string }>(
    "SELECT status FROM event_occurrences WHERE id = ?",
    occurrenceId,
  )[0]?.status;
}

function seriesRow(
  scenario: Scenario,
  seriesId: string,
): { title: string; local_time: string; duration_minutes: number } | undefined {
  return scenario.query<{ title: string; local_time: string; duration_minutes: number }>(
    "SELECT title, local_time, duration_minutes FROM event_series WHERE id = ?",
    seriesId,
  )[0];
}

async function expectListedByDay(scenario: Scenario, session: RoleSession, teamId: string) {
  const query = `/app/schedule?team=${teamId}`;
  await openFresh(session, query);
  const upcoming = main(session.page).locator('section[aria-labelledby="schedule-upcoming"]');
  const days = await upcoming.locator("ol > li").evaluateAll((items) =>
    items.map((item) => ({
      date: item.querySelector("time")?.getAttribute("datetime") ?? "",
      titles: [...item.querySelectorAll("h3 a")].map((link) => link.textContent ?? ""),
    })),
  );
  const dates = days.map((day) => day.date);
  expect(dates).toEqual(dates.toSorted());
  expect(new Set(dates).size).toBe(dates.length);
  const expected = scenario.query<{ local_date: string; title: string }>(
    "SELECT event_occurrences.local_date, event_series.title FROM event_occurrences JOIN event_series ON event_series.id = event_occurrences.series_id WHERE event_occurrences.team_id = ? AND event_occurrences.local_date >= ? ORDER BY event_occurrences.local_date",
    teamId,
    localDatePlus(1),
  );
  for (const row of expected) {
    const day = days.find((candidate) => candidate.date === row.local_date);
    expect(`${row.local_date}: ${day?.titles.includes(row.title) === true}`).toBe(
      `${row.local_date}: true`,
    );
  }
}

async function cancelPractice(scenario: Scenario, session: RoleSession): Promise<void> {
  const occurrences = practiceOccurrences(scenario);
  const target = occurrences.at(-1);
  if (target === undefined) throw new Error("no practice to cancel");
  await openFresh(session, eventPath(target.id));
  await button(session.page, "Cancel this date").click();
  const form = main(session.page).getByRole("form", { name: "Cancel Practice on this date" });
  await form.getByLabel("Reason").fill("Field closed for e2e");
  await Promise.all([
    session.page.waitForEvent("load"),
    form.getByRole("button", { name: "Confirm cancellation" }).click(),
  ]);
  const text = await openFresh(session, eventPath(target.id));
  expect(text).toContain("This date is cancelled.");
  expect(text).toContain("Field closed for e2e");
  await expectNoButton(session.page, "Cancel this date");
  expect(occurrenceStatus(scenario, target.id)).toBe("cancelled");
  for (const other of occurrences.slice(0, -1)) {
    expect(occurrenceStatus(scenario, other.id)).toBe("scheduled");
  }
}

async function exportCsv(session: RoleSession): Promise<void> {
  const reply = await session.api("GET", EXPORT_PAGE);
  expect(reply.status).toBe(200);
  expect(reply.text.replace(/^﻿/u, "")).toStartWith(CSV_HEADER);
  expect(reply.text).toContain(SEED_SCHEDULE.gameTitles[0]);
}

async function refuseCoachWrites(session: RoleSession, statuses: readonly number[]) {
  const target = `/api/teams/${FALCONS.teamId}`;
  await refused(
    session,
    "POST",
    `${target}/seasons/${FALCONS.seasonId}/events`,
    REFUSED_EVENT,
    statuses,
  );
  await refused(
    session,
    "POST",
    `${target}/events/${SERIES.hawks}/update`,
    { ...REFUSED_EVENT, title: "Refused edit" },
    statuses,
  );
  await refused(
    session,
    "POST",
    `${target}/occurrences/${OCCURRENCES.hawks}/cancel`,
    { reason: "Refused cancel" },
    statuses,
  );
}

function expectNoCoachWrites(scenario: Scenario): void {
  expect(scenario.query("SELECT id FROM event_series WHERE title = 'Refused event'")).toHaveLength(
    0,
  );
  expect(seriesRow(scenario, SERIES.hawks)?.title).toBe(SEED_SCHEDULE.gameTitles[0]);
  expect(occurrenceStatus(scenario, OCCURRENCES.hawks)).toBe("scheduled");
}

describe("schedule as owner (head-coach)", () => {
  const scenario = useScenario();

  test("lists every upcoming Falcons date under its own day, in order", async () => {
    await asRole(scenario(), "head-coach", (session) =>
      expectListedByDay(scenario(), session, FALCONS.teamId),
    );
  });

  test("opens an event's detail with its facts, coach controls and a working .ics link", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      const text = await openFresh(session, eventPath(OCCURRENCES.hawks));
      expect(text).toContain(SEED_SCHEDULE.gameTitles[0]);
      expect(text).toContain("Riverside Park, Field 1");
      expect(text).toContain("Take attendance");
      await main(session.page).getByRole("link", { name: "Edit series" }).waitFor();
      await button(session.page, "Cancel this date").waitFor();
      const ics = await session.api(
        "GET",
        teamApi(FALCONS.teamId, `/occurrences/${OCCURRENCES.hawks}/export`),
      );
      expect(ics.status).toBe(200);
      expect(ics.text).toContain("BEGIN:VCALENDAR");
      await expectHtmlLacks(session.page, [CHILDREN.quinn.displayName]);
    });
  });

  test("creates a one-time game with a snack duty, and a fresh load lists it", async () => {
    const date = localDatePlus(4);
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, NEW_EVENT_PAGE);
      const form = main(session.page).getByRole("form", { name: "Create event" });
      await form.getByLabel("Title").fill("E2E Scrimmage");
      await form.getByLabel("Type").selectOption("game");
      await form.getByLabel(/Location/u).fill("E2E Field");
      await form.getByLabel("Date", { exact: true }).fill(date);
      await form.getByLabel("Starts").fill("18:00");
      await form.getByLabel("Ends", { exact: true }).fill("19:30");
      await form.getByLabel("Add a snack duty for families to claim").check();
      await form.getByLabel("Duty name").fill("E2E Snacks");
      await Promise.all([
        session.page.waitForURL(/\/app\/schedule\/events\//u),
        form.getByRole("button", { name: "Create event" }).click(),
      ]);
      await session.page.waitForLoadState("load");
      const detail = await openFresh(session, session.page.url());
      expect(detail).toContain("E2E Scrimmage");
      expect(detail).toContain("6:00 PM – 7:30 PM");
      expect(detail).toContain("E2E Snacks");
      const list = await openFresh(session, SCHEDULE_PAGE);
      expect(list).toContain("E2E Scrimmage");
    });
    const [series] = scenario().query<{ id: string; duration_minutes: number }>(
      "SELECT id, duration_minutes FROM event_series WHERE title = 'E2E Scrimmage'",
    );
    expect(series?.duration_minutes).toBe(90);
    expect(
      scenario().query(
        "SELECT duty_slots.id FROM duty_slots JOIN event_occurrences ON event_occurrences.id = duty_slots.occurrence_id WHERE event_occurrences.series_id = ? AND duty_slots.label = 'E2E Snacks'",
        series?.id ?? "",
      ),
    ).toHaveLength(1);
  });

  test("cancels one practice date, and a fresh load shows only that date cancelled", async () => {
    await asRole(scenario(), "head-coach", (session) => cancelPractice(scenario(), session));
  });

  test("exports the schedule as CSV", async () => {
    await asRole(scenario(), "head-coach", exportCsv);
  });

  test("edits the practice series to end the next day, and a fresh load shows the new times", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, seriesEditPath(SERIES.practice));
      const form = main(session.page).getByRole("form", { name: "Edit event series" });
      await form.getByLabel("Title").fill("E2E Late Practice");
      await form.getByLabel("Starts").fill("22:00");
      await form.getByLabel("Ends", { exact: true }).fill("01:00");
      await form.getByLabel("Ends the next day").check();
      await Promise.all([
        session.page.waitForEvent("load"),
        form.getByRole("button", { name: "Save series" }).click(),
      ]);
      const next = practiceOccurrences(scenario())[0];
      if (next === undefined) throw new Error("no practice left");
      const text = await openFresh(session, eventPath(next.id));
      expect(text).toContain("E2E Late Practice");
      expect(text).toContain("10:00 PM – 1:00 AM");
      await openFresh(session, seriesEditPath(SERIES.practice));
      const reopened = main(session.page).getByRole("form", { name: "Edit event series" });
      expect(await reopened.getByLabel("Ends the next day").isChecked()).toBe(true);
    });
    expect(seriesRow(scenario(), SERIES.practice)).toEqual({
      title: "E2E Late Practice",
      local_time: "22:00",
      duration_minutes: 180,
    });
  });

  test("edits a one-time game's title and location, and a fresh load shows them", async () => {
    await asRole(scenario(), "head-coach", async (session) => {
      await openFresh(session, seriesEditPath(SERIES.owls));
      const form = main(session.page).getByRole("form", { name: "Edit event series" });
      await form.getByLabel("Title").fill("E2E Owls Rematch");
      await form.getByLabel(/Location/u).fill("E2E Diamond");
      await Promise.all([
        session.page.waitForEvent("load"),
        form.getByRole("button", { name: "Save series" }).click(),
      ]);
      const text = await openFresh(session, eventPath(OCCURRENCES.owls));
      expect(text).toContain("E2E Owls Rematch");
      expect(text).toContain("E2E Diamond");
    });
    expect(seriesRow(scenario(), SERIES.owls)?.title).toBe("E2E Owls Rematch");
  });
});

describe("schedule as co-coach (co-coach)", () => {
  const scenario = useScenario();

  test("cancels one practice date, and a fresh load shows only that date cancelled", async () => {
    await asRole(scenario(), "co-coach", (session) => cancelPractice(scenario(), session));
  });

  test("exports the schedule as CSV", async () => {
    await asRole(scenario(), "co-coach", exportCsv);
  });
});

describe("schedule as guardian of two (parent)", () => {
  const scenario = useScenario();

  test("lists every upcoming Falcons date under its own day, with no coach actions", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await expectListedByDay(scenario(), session, FALCONS.teamId);
      await expectHtmlLacks(session.page, ["Create event", "Export CSV"]);
    });
  });

  test("RSVPs for their own child, and a fresh load shows the answer", async () => {
    expect(attendanceStatus(scenario(), OCCURRENCES.hawks, CHILDREN.avery.participantId)).toBe(
      "no",
    );
    await asRole(scenario(), "parent", async (session) => {
      const text = await openFresh(session, eventPath(OCCURRENCES.hawks));
      expect(text).toContain("RSVP for your players");
      expect(text.includes(CHILDREN.casey.displayName)).toBe(false);
      await expectNoButton(session.page, "Cancel this date");
      expect(await main(session.page).getByRole("link", { name: "Edit series" }).count()).toBe(0);
      const avery = main(session.page).getByRole("group", {
        name: `RSVP for ${CHILDREN.avery.displayName}`,
      });
      await avery.getByRole("button", { name: "Going", exact: true }).click();
      await waitForStatus(session.page, /Avery/u);
      await openFresh(session, eventPath(OCCURRENCES.hawks));
      expect(
        await main(session.page)
          .getByRole("group", { name: `RSVP for ${CHILDREN.avery.displayName}` })
          .getByRole("button", { name: "Going", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        await main(session.page)
          .getByRole("group", { name: `RSVP for ${CHILDREN.casey.displayName}` })
          .count(),
      ).toBe(0);
    });
    expect(attendanceStatus(scenario(), OCCURRENCES.hawks, CHILDREN.avery.participantId)).toBe(
      "yes",
    );
  });

  test("server refuses an RSVP for another family's child (403/404): proves the own-child RSVP guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await refused(
        session,
        "POST",
        teamApi(FALCONS.teamId, `/occurrences/${OCCURRENCES.hawks}/attendance`),
        { participantId: CHILDREN.casey.participantId, status: "yes" },
      );
    });
    expect(
      attendanceStatus(scenario(), OCCURRENCES.hawks, CHILDREN.casey.participantId),
    ).toBeUndefined();
  });

  test("the CSV export answers 403 to a guardian and sends no file: proves the export coach guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await session.open(EXPORT_PAGE, 403);
      const reply = await refused(session, "GET", EXPORT_PAGE, undefined, [403]);
      expect(reply.text.includes(CSV_HEADER)).toBe(false);
    });
  });

  test("server refuses create, edit and cancel to a guardian (404): proves the schedule manage guard", async () => {
    await asRole(scenario(), "parent", async (session) => {
      await refuseCoachWrites(session, [404]);
      await session.open(seriesEditPath(SERIES.hawks), 403);
      await expectNoButton(session.page, "Save series");
    });
    expectNoCoachWrites(scenario());
  });
});

describe("schedule as second-team guardian (second-team-guardian)", () => {
  const scenario = useScenario();

  test("lists the Comets clinic by day and RSVPs for Quinn, and a fresh load shows it", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await expectListedByDay(scenario(), session, COMETS.teamId);
      await openFresh(session, eventPath(OCCURRENCES.clinic, COMETS.teamId));
      await main(session.page)
        .getByRole("group", { name: `RSVP for ${CHILDREN.quinn.displayName}` })
        .getByRole("button", { name: "Maybe", exact: true })
        .click();
      await waitForStatus(session.page, /Quinn/u);
      await openFresh(session, eventPath(OCCURRENCES.clinic, COMETS.teamId));
      expect(
        await main(session.page)
          .getByRole("group", { name: `RSVP for ${CHILDREN.quinn.displayName}` })
          .getByRole("button", { name: "Maybe", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        await main(session.page)
          .getByRole("group", { name: `RSVP for ${CHILDREN.jordan.displayName}` })
          .count(),
      ).toBe(0);
    });
    expect(attendanceStatus(scenario(), OCCURRENCES.clinic, CHILDREN.quinn.participantId)).toBe(
      "maybe",
    );
  });

  test("server refuses an RSVP for a teammate's child on the same team (403/404): proves the own-child RSVP guard", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(
        session,
        "POST",
        teamApi(COMETS.teamId, `/occurrences/${OCCURRENCES.clinic}/attendance`),
        { participantId: CHILDREN.jordan.participantId, status: "no" },
      );
    });
    expect(
      attendanceStatus(scenario(), OCCURRENCES.clinic, CHILDREN.jordan.participantId),
    ).toBeUndefined();
  });

  test("server refuses every Falcons schedule call and page to a Comets-only guardian (404)", async () => {
    await asRole(scenario(), "second-team-guardian", async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId, "/events"), undefined, [404]);
      await refused(
        session,
        "POST",
        teamApi(FALCONS.teamId, `/occurrences/${OCCURRENCES.hawks}/attendance`),
        { participantId: CHILDREN.avery.participantId, status: "yes" },
        [404],
      );
      await refuseCoachWrites(session, [404]);
      await session.open(eventPath(OCCURRENCES.hawks), 404);
      await expectHtmlLacks(session.page, [SEED_SCHEDULE.gameTitles[0], FALCONS.name]);
      await session.open(EXPORT_PAGE, 404);
    });
    expectNoCoachWrites(scenario());
  });
});

describe("schedule as adult member (team-member)", () => {
  const scenario = useScenario();

  test("sees the event with no RSVP choice and no coach controls", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      const text = await openFresh(session, eventPath(OCCURRENCES.hawks));
      expect(text).toContain("No RSVP choices are available for this account.");
      await expectNoButton(session.page, "Going");
      await expectNoButton(session.page, "Cancel this date");
    });
  });

  test("server refuses an adult member's RSVP for any child and every coach write (403/404): proves the RSVP and manage guards", async () => {
    await asRole(scenario(), "team-member", async (session) => {
      await refused(
        session,
        "POST",
        teamApi(FALCONS.teamId, `/occurrences/${OCCURRENCES.hawks}/attendance`),
        { participantId: CHILDREN.avery.participantId, status: "yes" },
      );
      await refuseCoachWrites(session, [404]);
      await session.open(EXPORT_PAGE, 403);
    });
    expect(attendanceStatus(scenario(), OCCURRENCES.hawks, CHILDREN.avery.participantId)).toBe(
      "no",
    );
    expectNoCoachWrites(scenario());
  });
});

describe("schedule as stranger (stranger)", () => {
  const scenario = useScenario();

  test("server refuses every Falcons schedule call and page to a stranger (404)", async () => {
    await asRole(scenario(), "stranger", async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId, "/events"), undefined, [404]);
      await refuseCoachWrites(session, [404]);
      await session.open(seriesEditPath(SERIES.hawks), 404);
      await session.open(NEW_EVENT_PAGE, 404);
      await session.open(EXPORT_PAGE, 404);
    });
    expectNoCoachWrites(scenario());
  });
});

describe("schedule as signed-out visitor", () => {
  const scenario = useScenario();
  const signedOut: Role = "signed-out";

  test("server answers 401 to every schedule call and the export", async () => {
    await asRole(scenario(), signedOut, async (session) => {
      await refused(session, "GET", teamApi(FALCONS.teamId, "/events"), undefined, [401]);
      await refuseCoachWrites(session, [401]);
      await session.open(EXPORT_PAGE, 401);
      await expectHtmlLacks(session.page, [SEED_SCHEDULE.gameTitles[0]]);
    });
    expectNoCoachWrites(scenario());
  });
});
