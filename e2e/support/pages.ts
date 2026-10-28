import { expect } from "bun:test";
import type { Locator, Page } from "playwright-core";

import { SEED_CHILDREN, SEED_PERSONAS, SEED_TEAMS } from "../../apps/web/app/dev/seed-personas";
import type { Scenario } from "./scenario";

export const FALCONS = SEED_TEAMS.coached;
export const COMETS = SEED_TEAMS.second;
export const CHILDREN = SEED_CHILDREN;

export const OCCURRENCES = {
  hawks: "event_occurrence_seed_falcons_hawks",
  owls: "event_occurrence_seed_falcons_owls",
  rays: "event_occurrence_seed_falcons_rays",
  clinic: "event_occurrence_seed_comets_clinic",
} as const;

export const SERIES = {
  practice: "event_series_seed_falcons_practice",
  hawks: "event_series_seed_falcons_hawks",
  owls: "event_series_seed_falcons_owls",
} as const;

export const SLOTS = {
  hawksSnacks: "duty_slot_seed_hawks_snacks",
  hawksScorebook: "duty_slot_seed_hawks_scorebook",
  hawksFieldSetup: "duty_slot_seed_hawks_field_setup",
  owlsSnacks: "duty_slot_seed_owls_snacks",
  owlsScorebook: "duty_slot_seed_owls_scorebook",
  owlsFieldSetup: "duty_slot_seed_owls_field_setup",
  clinicSnacks: "duty_slot_seed_comets_clinic_snacks",
} as const;

export const APP_SECTIONS = [
  { path: "/app", label: "Overview" },
  { path: "/app/team", label: "Team" },
  { path: "/app/roster", label: "Roster" },
  { path: "/app/schedule", label: "Schedule" },
  { path: "/app/duties", label: "Duties" },
] as const;

export function teamApi(teamId: string, rest = ""): string {
  return `/api/teams/${teamId}${rest}`;
}

export function eventPath(occurrenceId: string, teamId: string = FALCONS.teamId): string {
  return `/app/schedule/events/${occurrenceId}?team=${teamId}`;
}

export function seriesEditPath(seriesId: string, teamId: string = FALCONS.teamId): string {
  return `/app/schedule/series/${seriesId}/edit?team=${teamId}`;
}

export function cardPath(participantId: string, team = FALCONS): string {
  return `/app/roster/${participantId}?team=${team.teamId}&season=${team.seasonId}`;
}

export function main(page: Page): Locator {
  return page.locator("main");
}

export async function mainText(page: Page): Promise<string> {
  return (await main(page).innerText()).replaceAll(/\s+/gu, " ");
}

export async function expectNoSkeleton(page: Page): Promise<void> {
  expect(await page.locator('main [aria-busy="true"]').count()).toBe(0);
}

export async function expectHydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll("[data-lesto-island]").length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForLoadState("networkidle");
}

export async function expectVisibleText(page: Page, text: string | RegExp): Promise<void> {
  await main(page)
    .getByText(text)
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

export async function expectAbsentText(page: Page, text: string | RegExp): Promise<void> {
  expect(await main(page).getByText(text).count()).toBe(0);
}

export async function expectHtmlLacks(page: Page, needles: readonly string[]): Promise<void> {
  const html = await page.content();
  for (const needle of needles) expect(html.includes(needle) ? needle : "").toBe("");
}

export function seededBirthDates(scenario: Scenario): string[] {
  return scenario
    .query<{ birth_date: string }>(
      "SELECT birth_date FROM participants WHERE birth_date IS NOT NULL",
    )
    .map((row) => row.birth_date);
}

export function practiceOccurrences(scenario: Scenario): { id: string; local_date: string }[] {
  return scenario.query<{ id: string; local_date: string }>(
    "SELECT id, local_date FROM event_occurrences WHERE series_id = ? AND status = 'scheduled' ORDER BY local_date",
    SERIES.practice,
  );
}

export function slotAssignee(scenario: Scenario, slotId: string): string | null {
  const [row] = scenario.query<{ assignee_person_id: string | null }>(
    "SELECT assignee_person_id FROM duty_slots WHERE id = ?",
    slotId,
  );
  if (row === undefined) throw new Error(`no duty slot ${slotId}`);
  return row.assignee_person_id;
}

export async function openFresh(
  session: { open(path: string, expectedStatus?: number): Promise<unknown>; page: Page },
  path: string,
): Promise<string> {
  await session.open(path);
  await expectHydrated(session.page);
  await expectNoSkeleton(session.page);
  return mainText(session.page);
}

export function button(page: Page, name: string | RegExp): Locator {
  return main(page).getByRole("button", { name, exact: typeof name === "string" });
}

export async function expectNoButton(page: Page, name: string | RegExp): Promise<void> {
  expect(`${String(name)}: ${await button(page, name).count()}`).toBe(`${String(name)}: 0`);
}

export async function waitForStatus(page: Page, text: string | RegExp): Promise<void> {
  await main(page)
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: text })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

export function persona(key: string): (typeof SEED_PERSONAS)[number] {
  const found = SEED_PERSONAS.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no seeded persona ${key}`);
  return found;
}

export function localDatePlus(days: number, timeZone = "America/Phoenix"): string {
  const instant = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}
