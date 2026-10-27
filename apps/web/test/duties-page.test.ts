import { createApp } from "@lesto/kernel";
import { createElement } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DutiesBoard } from "../app/duties/duties-board";
import { assignableTeamAdults, loadDutiesPage } from "../app/duties/duties-data";
import { performDutyAction, sortSlotsSnacksFirst } from "../app/duties/duties-model";
import type { DutiesBoardProps, DutiesRequest, DutiesTransport } from "../app/duties/duties-model";
import { DEV_PERSONAS } from "../app/lib/server/identity";
import { registerRuntimePages } from "../runtime/web-surface";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const { default: config, services } = await import("./support/application").then((module) =>
  module.testApplication(),
);
await registerRuntimePages(config.app);
const app = await createApp(config);

const OWNER_NAME = DEV_PERSONAS.default.displayName;
const PARENT_NAME = DEV_PERSONAS["second-adult"].displayName;
const PARENT_ID = DEV_PERSONAS["second-adult"].personId;

async function clearState() {
  await config.db.exec(
    "DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM duty_slots; DELETE FROM event_attendance; DELETE FROM calendar_feed_tokens; DELETE FROM event_creation_receipts; DELETE FROM event_occurrences; DELETE FROM event_series; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

const sameOrigin = { "sec-fetch-site": "same-origin" };

function json(response: { body: unknown }): unknown {
  return JSON.parse(String(response.body));
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function pageText(response: { body: unknown }): Promise<string> {
  const text =
    typeof response.body === "string"
      ? response.body
      : await new Response(response.body as ReadableStream).text();
  return text
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

function dateDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

async function post(cookie: string, path: string, body?: unknown) {
  return app.handle("POST", path, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

async function createEvent(
  cookie: string,
  teamId: string,
  seasonId: string,
  title: string,
  kind: "game" | "practice",
  daysFromNow: number,
): Promise<string> {
  const response = await post(cookie, `/api/teams/${teamId}/seasons/${seasonId}/events`, {
    title,
    kind,
    location: "Field 2",
    schedule: {
      timeZone: "UTC",
      localTime: "12:00",
      durationMinutes: 60,
      frequency: "once",
      startDate: dateDaysFromNow(daysFromNow),
    },
  });
  expect(response.status).toBe(201);
  return (json(response) as { occurrences: Array<{ id: string }> }).occurrences[0]?.id ?? "";
}

async function addSlot(
  cookie: string,
  teamId: string,
  occurrenceId: string,
  label: string,
  instructions?: string,
): Promise<string> {
  const response = await post(
    cookie,
    `/api/teams/${teamId}/occurrences/${occurrenceId}/duty-slots`,
    {
      label,
      ...(instructions === undefined ? {} : { instructions }),
    },
  );
  expect(response.status).toBe(201);
  return (json(response) as { dutySlot: { id: string } }).dutySlot.id;
}

interface Fixture {
  readonly ownerCookie: string;
  readonly teamId: string;
  readonly seasonId: string;
  readonly gameId: string;
  readonly practiceId: string;
  readonly snackSlotId: string;
  readonly setupSlotId: string;
}

async function seedTeam(ownerCookie: string): Promise<Fixture> {
  const team = await post(ownerCookie, "/api/teams", { name: "Duty Falcons" });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;
  const season = await post(ownerCookie, `/api/teams/${teamId}/seasons`, {
    label: "Fall 2026",
    startDate: dateDaysFromNow(-30),
    endDate: dateDaysFromNow(60),
    timeZone: "UTC",
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;

  const practiceId = await createEvent(
    ownerCookie,
    teamId,
    seasonId,
    "Tuesday practice",
    "practice",
    5,
  );
  const gameId = await createEvent(ownerCookie, teamId, seasonId, "Saturday game", "game", 3);
  const setupSlotId = await addSlot(ownerCookie, teamId, gameId, "Field setup");
  const snackSlotId = await addSlot(
    ownerCookie,
    teamId,
    gameId,
    "Snacks",
    "Enough for twelve players",
  );
  return { ownerCookie, teamId, seasonId, gameId, practiceId, snackSlotId, setupSlotId };
}

async function joinAsParent(fixture: Fixture): Promise<string> {
  const child = await post(
    fixture.ownerCookie,
    `/api/teams/${fixture.teamId}/seasons/${fixture.seasonId}/participants`,
    { displayName: "Casey Kid", birthDate: "2018-04-09" },
  );
  expect(child.status).toBe(201);
  const participantId = (json(child) as { participant: { participantId: string } }).participant
    .participantId;
  const parentCookie = await signIn("second-adult");
  const invitation = await post(fixture.ownerCookie, `/api/teams/${fixture.teamId}/invitations`, {
    invitedRole: "adult",
    inviteeLabel: "Second parent",
    recipientBinding: { kind: "confirmed_person", personId: PARENT_ID },
    participantId,
    relationship: "parent",
  });
  expect(invitation.status).toBe(201);
  const inviteUrl = (json(invitation) as { invitation: { inviteUrl: string } }).invitation
    .inviteUrl;
  const accepted = await post(parentCookie, "/api/invitations/accept", {
    token: inviteUrl.split("#")[1] ?? "",
  });
  expect(accepted.status).toBe(200);
  return parentCookie;
}

async function grantCoCoach(fixture: Fixture): Promise<void> {
  const granted = await post(
    fixture.ownerCookie,
    `/api/teams/${fixture.teamId}/adult-members/${PARENT_ID}/co-coach/grant`,
  );
  expect(granted.status).toBe(200);
}

async function dutiesPage(cookie: string | undefined, query: Record<string, string> = {}) {
  return app.handle("GET", "/app/duties", {
    headers: cookie === undefined ? {} : { cookie },
    query,
  });
}

async function boardFor(cookie: string): Promise<DutiesBoardProps> {
  const loaded = await loadDutiesPage(services, cookie, {});
  if (loaded.state !== "board") throw new Error(`Expected a duties board, got ${loaded.state}.`);
  return loaded.board;
}

function transportFor(cookie: string): DutiesTransport {
  return async (request) => {
    const response = await app.handle(request.method, request.url, {
      headers: { ...sameOrigin, cookie },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const text = await pageText(response);
    return {
      status: response.status,
      json: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  };
}

async function slotRow(slotId: string) {
  return (await config.db
    .prepare("SELECT assignee_person_id AS assignee FROM duty_slots WHERE id = ?")
    .get([slotId])) as { assignee: string | null };
}

describe("/app/duties page through the real app", () => {
  it("shows the owner every upcoming event, snacks first, with coach controls", async () => {
    const fixture = await seedTeam(await signIn());

    const response = await dutiesPage(fixture.ownerCookie);
    expect(response.status).toBe(200);
    const html = await pageText(response);
    expect(html).toContain("Duty Falcons");
    expect(html).toContain("Fall 2026");
    expect(html).toContain("My duties");
    expect(html).toContain("You hold no upcoming duties");
    expect(html).toContain("Saturday game");
    expect(html).toContain("Tuesday practice");
    expect(html.indexOf("Saturday game")).toBeLessThan(html.indexOf("Tuesday practice"));
    expect(html.indexOf(">Snacks<")).toBeLessThan(html.indexOf(">Field setup<"));
    expect(html).toContain("Enough for twelve players");
    expect(html).toContain('data-slot-state="open"');
    expect(html).toContain("2 open slots");
    expect(html).toContain("No duty slots yet. Add one below.");
    expect(html).toContain("Add a duty slot");
    expect(html).toContain("Assign an adult");
    expect(html).toContain("DutiesBoard");
  });

  it("shows a parent the board and their claims without coach controls", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    expect(
      (
        await post(
          parentCookie,
          `/api/teams/${fixture.teamId}/occurrences/${fixture.gameId}/duty-slots/${fixture.snackSlotId}/claim`,
        )
      ).status,
    ).toBe(200);

    const response = await dutiesPage(parentCookie);
    expect(response.status).toBe(200);
    const html = await pageText(response);
    expect(html).toContain("Saturday game");
    expect(html).toContain("Claimed by you");
    expect(html).toContain("Claim Field setup");
    expect(html).toContain('aria-label="My duties"');
    expect(html).not.toContain("You hold no upcoming duties");
    expect(html).not.toContain("Add a duty slot");
    expect(html).not.toContain("Assign an adult");
    expect(html).not.toContain("Unassign");
    expect(html).toContain('"adults":[]');
    expect(html).not.toContain(`"${DEV_PERSONAS.default.personId}"`);
    expect(html).not.toContain("2018-04-09");

    const ownerHtml = await pageText(await dutiesPage(fixture.ownerCookie));
    expect(ownerHtml).toContain(`Claimed by ${PARENT_NAME}`);
    expect(ownerHtml).toContain("Unassign");
  });

  it("gives a co-coach the coach controls", async () => {
    const fixture = await seedTeam(await signIn());
    const coachCookie = await joinAsParent(fixture);
    await grantCoCoach(fixture);

    const html = await pageText(await dutiesPage(coachCookie));
    expect(html).toContain("Add a duty slot");
    expect(html).toContain("Assign an adult");
    expect(html).toContain(OWNER_NAME);
  });

  it("answers a stranger 404 for a team they are not on, and an empty state otherwise", async () => {
    const fixture = await seedTeam(await signIn());
    const strangerCookie = await signIn("second-adult");

    const addressed = await dutiesPage(strangerCookie, { team: fixture.teamId });
    expect(addressed.status).toBe(404);
    const addressedHtml = await pageText(addressed);
    expect(addressedHtml).not.toContain("Duty Falcons");
    expect(addressedHtml).not.toContain("Saturday game");

    const unaddressed = await dutiesPage(strangerCookie);
    expect(unaddressed.status).toBe(200);
    const html = await pageText(unaddressed);
    expect(html).toContain("No team yet");
    expect(html).not.toContain("Duty Falcons");
  });

  it("answers 404 for a season that is not the selected team's", async () => {
    const fixture = await seedTeam(await signIn());
    const response = await dutiesPage(fixture.ownerCookie, {
      team: fixture.teamId,
      season: "season_unknown",
    });
    expect(response.status).toBe(404);

    const selected = await dutiesPage(fixture.ownerCookie, {
      team: fixture.teamId,
      season: fixture.seasonId,
    });
    expect(selected.status).toBe(200);
    expect(await pageText(selected)).toContain("Saturday game");
  });

  it("shows the signed-out state and no team data without a session", async () => {
    await seedTeam(await signIn());
    for (const cookie of [undefined, "snackday_session_dev=forged-token"]) {
      const response = await dutiesPage(cookie);
      expect(response.status).toBe(200);
      const html = await pageText(response);
      expect(html).toContain("Signed out");
      expect(html).not.toContain("Duty Falcons");
      expect(html).not.toContain("DutiesBoard");
    }
  });

  it("renders honest empty states as the season fills in", async () => {
    const ownerCookie = await signIn();
    const team = await post(ownerCookie, "/api/teams", { name: "Empty Owls" });
    const teamId = (json(team) as { team: { id: string } }).team.id;
    expect(await pageText(await dutiesPage(ownerCookie))).toContain("No season yet");

    await post(ownerCookie, `/api/teams/${teamId}/seasons`, {
      label: "Fall 2026",
      startDate: dateDaysFromNow(-30),
      endDate: dateDaysFromNow(60),
      timeZone: "UTC",
    });
    const html = await pageText(await dutiesPage(ownerCookie));
    expect(html).toContain("No upcoming events");
    expect(html).not.toContain("DutiesBoard");
  });

  it("leaves past and cancelled events honest", async () => {
    const fixture = await seedTeam(await signIn());
    const cancelled = await post(
      fixture.ownerCookie,
      `/api/teams/${fixture.teamId}/occurrences/${fixture.practiceId}/cancel`,
      { reason: "Rain" },
    );
    expect(cancelled.status).toBe(200);

    const html = await pageText(await dutiesPage(fixture.ownerCookie));
    expect(html).toContain("Tuesday practice");
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("No duty slots yet. Add one below.");
    expect(html).toContain("This event is cancelled, so it needs no duties.");

    const board = await loadDutiesPage(
      { ...services, clock: () => Date.now() + 4 * 86_400_000 },
      fixture.ownerCookie,
      {},
    );
    if (board.state !== "board") throw new Error("Expected a board.");
    expect(board.board.occurrences.map((occurrence) => occurrence.title)).toEqual([
      "Tuesday practice",
    ]);
  });

  it("lists assignable adults only for a manager", async () => {
    const fixture = await seedTeam(await signIn());
    await joinAsParent(fixture);

    const owner = await assignableTeamAdults(
      services.db,
      fixture.teamId,
      DEV_PERSONAS.default.personId,
    );
    expect(owner.map((adult) => adult.displayName)).toEqual([OWNER_NAME, PARENT_NAME]);
    expect(await assignableTeamAdults(services.db, fixture.teamId, PARENT_ID)).toEqual([]);
  });
});

describe("snack-first ordering", () => {
  it("puts snack slots first and keeps the rest in order", () => {
    expect(
      sortSlotsSnacksFirst([
        { label: "Field setup" },
        { label: "Team snack" },
        { label: "Scorebook" },
        { label: "Snacks" },
      ]).map((slot) => slot.label),
    ).toEqual(["Team snack", "Snacks", "Field setup", "Scorebook"]);
  });
});

describe("duties board island against the real API", () => {
  let createRoot: typeof import("react-dom/client").createRoot;
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const roots: Root[] = [];
  let closeWindow: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "https://snackday.test/app/duties" });
    closeWindow = () => dom.happyDOM.close();
    const globals = {
      window: dom,
      document: dom.document,
      FormData: dom.FormData,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    ({ createRoot } = await import("react-dom/client"));
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(() => root.unmount());
    document.body.innerHTML = "";
  });

  afterAll(async () => {
    await closeWindow();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });

  async function mount(
    cookie: string,
    options: { transport?: DutiesTransport; reload?: () => void } = {},
  ): Promise<HTMLElement> {
    const board = await boardFor(cookie);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(() =>
      root.render(
        createElement(DutiesBoard, {
          ...board,
          transport: options.transport ?? transportFor(cookie),
          ...(options.reload === undefined ? {} : { reload: options.reload }),
        }),
      ),
    );
    return container;
  }

  function unreadableListTransport(cookie: string, sent: DutiesRequest[]): DutiesTransport {
    const real = transportFor(cookie);
    return async (request) => {
      sent.push(request);
      if (request.method === "GET") return { status: 503, json: undefined };
      return real(request);
    };
  }

  async function settle(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }

  function button(container: HTMLElement, text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    );
    if (found === undefined) throw new Error(`Button "${text}" is missing.`);
    return found;
  }

  async function click(container: HTMLElement, text: string): Promise<void> {
    const target = button(container, text);
    await act(async () => {
      target.click();
    });
  }

  function myDutiesText(container: HTMLElement): string {
    return container.querySelector("#my-duties-title")?.parentElement?.textContent ?? "";
  }

  it("lets a parent claim an open slot and release their own claim", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    const container = await mount(parentCookie);
    expect(myDutiesText(container)).toContain("You hold no upcoming duties");

    await click(container, "Claim Snacks");
    await settle(() => container.textContent?.includes("You claimed Snacks.") ?? false);
    expect(container.textContent).toContain("You claimed Snacks.");
    expect(container.textContent).toContain("Claimed by you");
    expect(myDutiesText(container)).toContain("Snacks");
    expect(myDutiesText(container)).toContain("Saturday game");
    expect((await slotRow(fixture.snackSlotId)).assignee).toBe(PARENT_ID);

    await click(container, "Release");
    await settle(() => container.textContent?.includes("You released Snacks.") ?? false);
    expect(container.textContent).toContain("You released Snacks. It is open again.");
    expect(myDutiesText(container)).toContain("You hold no upcoming duties");
    expect(button(container, "Claim Snacks").disabled).toBe(false);
    expect((await slotRow(fixture.snackSlotId)).assignee).toBeNull();
  });

  it("shows the server answer and refreshes when someone else claims the slot first", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    const container = await mount(parentCookie);

    const ownerClaim = await post(
      fixture.ownerCookie,
      `/api/teams/${fixture.teamId}/occurrences/${fixture.gameId}/duty-slots/${fixture.snackSlotId}/claim`,
    );
    expect(ownerClaim.status).toBe(200);

    await click(container, "Claim Snacks");
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      `${OWNER_NAME} claimed Snacks first. The list now shows the latest.`,
    );
    expect(container.textContent).toContain(`Claimed by ${OWNER_NAME}`);
    expect(container.textContent).not.toContain("Claim Snacks");
    expect(myDutiesText(container)).toContain("You hold no upcoming duties");
    expect((await slotRow(fixture.snackSlotId)).assignee).toBe(DEV_PERSONAS.default.personId);
  });

  it("disables every action control on the board while any action is saving", async () => {
    const fixture = await seedTeam(await signIn());
    await addSlot(fixture.ownerCookie, fixture.teamId, fixture.practiceId, "Scorebook");
    const parentCookie = await joinAsParent(fixture);
    const real = transportFor(parentCookie);
    const sent: DutiesRequest[] = [];
    let releaseClaim: () => void = () => undefined;
    const claimHeld = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const container = await mount(parentCookie, {
      transport: async (request) => {
        sent.push(request);
        if (request.url.endsWith(`/${fixture.snackSlotId}/claim`)) await claimHeld;
        return real(request);
      },
    });

    await click(container, "Claim Snacks");
    expect(button(container, "Claim Scorebook").disabled).toBe(true);
    expect(button(container, "Claim Field setup").disabled).toBe(true);
    await click(container, "Claim Scorebook");
    expect(sent.map((request) => request.url)).toEqual([
      `/api/teams/${encodeURIComponent(fixture.teamId)}/occurrences/${encodeURIComponent(fixture.gameId)}/duty-slots/${encodeURIComponent(fixture.snackSlotId)}/claim`,
    ]);

    releaseClaim();
    await settle(() => container.textContent?.includes("You claimed Snacks.") ?? false);
    expect(button(container, "Claim Scorebook").disabled).toBe(false);
  });

  it("shows the saved claim from the claim answer without reading the list again", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    const sent: DutiesRequest[] = [];
    const container = await mount(parentCookie, {
      transport: unreadableListTransport(parentCookie, sent),
    });

    await click(container, "Claim Snacks");
    await settle(() => container.textContent?.includes("You claimed Snacks.") ?? false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("You claimed Snacks.");
    expect(container.textContent).toContain("Claimed by you");
    expect(container.textContent).not.toContain("Claim Snacks");
    expect(myDutiesText(container)).toContain("Snacks");
    expect(sent.filter((request) => request.method === "GET")).toEqual([]);
    expect(container.textContent).not.toContain("Reload the list");
  });

  it("says the list may be out of date and offers a reload when a race re-read fails", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    let reloads = 0;
    const container = await mount(parentCookie, {
      transport: unreadableListTransport(parentCookie, []),
      reload: () => {
        reloads += 1;
      },
    });
    const ownerClaim = await post(
      fixture.ownerCookie,
      `/api/teams/${fixture.teamId}/occurrences/${fixture.gameId}/duty-slots/${fixture.snackSlotId}/claim`,
    );
    expect(ownerClaim.status).toBe(200);

    await click(container, "Claim Snacks");
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Someone else claimed Snacks first. The list may be out of date.",
    );
    await click(container, "Reload the list");
    expect(reloads).toBe(1);
  });

  it("lets a coach add a slot, assign an adult, and unassign them", async () => {
    const fixture = await seedTeam(await signIn());
    await joinAsParent(fixture);
    const container = await mount(fixture.ownerCookie);

    const practiceCard = container.querySelector(`#duty-occurrence-${fixture.practiceId}`);
    if (practiceCard === null) throw new Error("Practice card is missing.");
    const form = practiceCard.querySelector('form[aria-label="Add a duty slot"]');
    if (!(form instanceof window.HTMLFormElement)) throw new Error("Add form is missing.");
    const label = form.querySelector('input[name="label"]') as HTMLInputElement;
    const instructions = form.querySelector('input[name="instructions"]') as HTMLInputElement;
    label.value = "Snacks";
    instructions.value = "Orange slices";
    await act(async () => {
      form.requestSubmit();
    });
    await settle(() => practiceCard.textContent?.includes("Added Snacks.") ?? false);
    expect(practiceCard.textContent).toContain("Added Snacks.");
    expect(practiceCard.textContent).toContain("Orange slices");
    const practiceSlots = (await config.db
      .prepare("SELECT id, label FROM duty_slots WHERE occurrence_id = ?")
      .all([fixture.practiceId])) as Array<{ id: string; label: string }>;
    expect(practiceSlots.map((slot) => slot.label)).toEqual(["Snacks"]);

    const gameCard = container.querySelector(`#duty-occurrence-${fixture.gameId}`);
    if (gameCard === null) throw new Error("Game card is missing.");
    const assignForm = gameCard.querySelector('form[aria-label="Assign Snacks"]');
    if (!(assignForm instanceof window.HTMLFormElement)) throw new Error("Assign form is missing.");
    const select = assignForm.querySelector("select") as HTMLSelectElement;
    select.value = PARENT_ID;
    await act(async () => {
      assignForm.requestSubmit();
    });
    await settle(() => gameCard.textContent?.includes(`${PARENT_NAME} now holds Snacks.`) ?? false);
    expect(gameCard.textContent).toContain(`Claimed by ${PARENT_NAME}`);
    expect((await slotRow(fixture.snackSlotId)).assignee).toBe(PARENT_ID);

    await click(gameCard as HTMLElement, "Unassign");
    await settle(() => gameCard.textContent?.includes("Snacks is open again.") ?? false);
    expect((await slotRow(fixture.snackSlotId)).assignee).toBeNull();
  });

  it("refuses coach actions a parent forges, and leaves the slot untouched", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    const board = await boardFor(parentCookie);
    const slots = board.occurrences[0]?.slots ?? [];

    const assigned = await performDutyAction(
      transportFor(parentCookie),
      fixture.teamId,
      {
        kind: "assign",
        occurrenceId: fixture.gameId,
        slotId: fixture.snackSlotId,
        assigneePersonId: PARENT_ID,
      },
      { slots, adults: [] },
    );
    expect(assigned.ok).toBe(false);
    expect(assigned.message).toBe("That duty or event is no longer available to you.");
    expect((await slotRow(fixture.snackSlotId)).assignee).toBeNull();

    const added = await performDutyAction(
      transportFor(parentCookie),
      fixture.teamId,
      { kind: "add", occurrenceId: fixture.gameId, label: "Forged" },
      { slots, adults: [] },
    );
    expect(added.ok).toBe(false);
    expect(added.slots?.map((slot) => slot.label)).toEqual(["Snacks", "Field setup"]);
  });

  it("refuses to release another adult's claim", async () => {
    const fixture = await seedTeam(await signIn());
    const parentCookie = await joinAsParent(fixture);
    await post(
      fixture.ownerCookie,
      `/api/teams/${fixture.teamId}/occurrences/${fixture.gameId}/duty-slots/${fixture.snackSlotId}/claim`,
    );
    const board = await boardFor(parentCookie);

    const released = await performDutyAction(
      transportFor(parentCookie),
      fixture.teamId,
      { kind: "release", occurrenceId: fixture.gameId, slotId: fixture.snackSlotId },
      { slots: board.occurrences[0]?.slots ?? [], adults: [] },
    );
    expect(released.ok).toBe(false);
    expect(released.message).toBe(
      `${OWNER_NAME} claimed Snacks first. The list now shows the latest.`,
    );
    expect((await slotRow(fixture.snackSlotId)).assignee).toBe(DEV_PERSONAS.default.personId);
  });
});
