import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { parseSkillEvents, rate, rulesV0, taxonomyV0 } from "@snackday/skill-engine";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { staticLessonCatalog } from "../app/lessons/catalog";
import { parseReelEpisode } from "../app/lessons/reel-contract";
import { seedEventIdStem } from "../app/dev/seed-event-ids";
import { DEV_SKILL_EVENTS_MAX_BATCH, registerDevSkillEventRoutes } from "../app/dev/skill-events";
import { COACH_CARD_READ_PERMISSION } from "../app/lessons/lessons";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { DEFAULT_GUARDIAN_PERMISSIONS, guardianRelationships } from "../app/lib/server/roster";
import {
  appendSkillEvents,
  checkPassedEventId,
  PLAYER_CARD_RULESET,
  playerIdFor,
  SkillEventInsertConflict,
} from "../app/skills/skill-events";
import { scenarioSkillEvents } from "../../../scripts/lib/dev-scenario-skill-events";

process.env.LESTO_DB = ":memory:";
process.env.SNACKDAY_DEV_SIGN_IN = "true";

const NOW = Date.UTC(2026, 9, 26, 19);
const DAY_MS = 24 * 60 * 60 * 1_000;
const clock = () => NOW;
const sameOrigin = { "sec-fetch-site": "same-origin" };
const littleLeague = { ruleset: PLAYER_CARD_RULESET };

const episodeManifest: unknown = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../contracts/reel-episode-v0/run-to-first.v1.episode.json"),
    "utf8",
  ),
);
const parsedEpisode = parseReelEpisode(episodeManifest);
if (!parsedEpisode.ok) throw new Error("Vendored manifest must parse.");
const episode = { lesson: parsedEpisode.value, quizSkills: parsedEpisode.quizSkills };

const { db: sql } = await openSqlite(":memory:");
const services = await identityServices(sql, { mode: "development", clock });
const { config } = createApplication({
  sql,
  db: services.db,
  sessions: services.sessions,
  mode: "development",
  clock,
  developmentSignIn: true,
  inviteDelivery: devInviteDeliverer(),
  invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
  lessons: { enabled: true, catalog: staticLessonCatalog([episode]) },
});
const app: App = await createApp({
  ...config,
  app: registerDevSkillEventRoutes(config.app, {
    enabled: true,
    db: services.db,
    sessions: services.sessions,
    clock,
  }),
});

async function clearState() {
  await sql.exec(
    "DELETE FROM skill_events; DELETE FROM lesson_answers; DELETE FROM lesto_jobs; DELETE FROM invitation_delivery_outbox; DELETE FROM adult_memberships; DELETE FROM invitations; DELETE FROM guardian_relationships; DELETE FROM memberships; DELETE FROM participants; DELETE FROM seasons; DELETE FROM teams; DELETE FROM lesto_sessions; DELETE FROM lesto_rate_limits; DELETE FROM accounts; DELETE FROM people;",
  );
}

beforeEach(clearState);
afterAll(clearState);

function json(response: { body: string }): unknown {
  return JSON.parse(response.body);
}

function header(response: { headers: Record<string, string | string[]> }, name: string): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function signIn(persona?: "second-adult"): Promise<string> {
  const response = await app.handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(persona === undefined ? {} : { body: { persona } }),
  });
  expect(response.status).toBe(200);
  return header(response, "set-cookie").split(";", 1)[0] ?? "";
}

async function personIdOf(cookie: string): Promise<string> {
  const session = await app.handle("GET", "/api/session", { headers: { cookie } });
  return (json(session) as { person: { id: string } }).person.id;
}

async function post(cookie: string, path: string, body?: unknown) {
  return app.handle("POST", path, {
    headers: { ...sameOrigin, cookie },
    ...(body === undefined ? {} : { body }),
  });
}

async function seedTeam(cookie: string, name: string) {
  const team = await post(cookie, "/api/teams", { name });
  expect(team.status).toBe(201);
  const teamId = (json(team) as { team: { id: string } }).team.id;
  const season = await post(cookie, `/api/teams/${teamId}/seasons`, {
    label: "Fall 2026",
    startDate: "2026-09-01",
    endDate: "2026-12-01",
    timeZone: "America/Los_Angeles",
  });
  expect(season.status).toBe(201);
  const seasonId = (json(season) as { season: { id: string } }).season.id;
  const participantIds: string[] = [];
  for (const displayName of ["Casey Kid", "Rowan Kid"]) {
    const child = await post(cookie, `/api/teams/${teamId}/seasons/${seasonId}/participants`, {
      displayName,
      birthDate: "2020-04-09",
    });
    expect(child.status).toBe(201);
    participantIds.push(
      (json(child) as { participant: { participantId: string } }).participant.participantId,
    );
  }
  const [casey, rowan] = participantIds;
  if (casey === undefined || rowan === undefined) throw new Error("Seed data is missing.");
  return { teamId, seasonId, casey, rowan };
}

async function joinTeam(
  ownerCookie: string,
  memberCookie: string,
  teamId: string,
  participantId?: string,
): Promise<void> {
  const created = await post(ownerCookie, `/api/teams/${teamId}/invitations`, {
    invitedRole: "adult",
    inviteeLabel: "joining adult",
    recipientBinding: { kind: "confirmed_person", personId: await personIdOf(memberCookie) },
    ...(participantId === undefined ? {} : { participantId, relationship: "parent" }),
  });
  expect(created.status).toBe(201);
  const inviteUrl =
    (json(created) as { invitation: { inviteUrl?: string } }).invitation.inviteUrl ?? "";
  const accepted = await post(memberCookie, "/api/invitations/accept", {
    token: inviteUrl.slice("/invite#".length),
  });
  expect(accepted.status).toBe(200);
}

function readCard(cookie: string, teamId: string, participantId: string) {
  return app.handle("GET", `/api/teams/${teamId}/participants/${participantId}/skill-card`, {
    headers: { cookie },
  });
}

function seedPath(teamId: string, participantId: string): string {
  return `/api/dev/teams/${teamId}/participants/${participantId}/skill-events`;
}

function localDate(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
}

function drill(participantId: string, index: number, daysAgo: number, skill: string) {
  const occurredAt = NOW - daysAgo * DAY_MS;
  return {
    contract: "skill.events/v0",
    id: `${seedEventIdStem(participantId)}seed${index}`,
    playerId: playerIdFor(participantId),
    occurredAt: new Date(occurredAt).toISOString(),
    localDate: localDate(occurredAt),
    app: "snackday",
    type: "drill_completed",
    skill,
    source: { kind: "drill", id: `seed/${skill.replace(".", "-")}` },
  };
}

function week(participantId: string) {
  return [6, 5, 4, 3, 2, 1, 0].map((daysAgo, index) =>
    drill(
      participantId,
      index,
      daysAgo,
      index % 2 === 0 ? "infield.ready-position" : "baserunning.out-of-the-box",
    ),
  );
}

async function storedEventRows(): Promise<{ id: string; participant_id: string }[]> {
  return (await sql.prepare("SELECT id, participant_id FROM skill_events ORDER BY id").all([])) as {
    id: string;
    participant_id: string;
  }[];
}

async function storedEventCount(): Promise<number> {
  const rows = (await sql.prepare("SELECT id FROM skill_events").all([])) as unknown[];
  return rows.length;
}

describe("coach read-only player card", () => {
  it("names a permission that owner and co-coach roles hold and parents do not", () => {
    expect(COACH_CARD_READ_PERMISSION).toBe("roster.manage");
  });

  it("lets the owner and a co-coach of the child's team read the card", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const coachCookie = await signIn("second-adult");
    await joinTeam(ownerCookie, coachCookie, teamId);

    expect((await readCard(coachCookie, teamId, casey)).status).toBe(404);
    const granted = await post(
      ownerCookie,
      `/api/teams/${teamId}/adult-members/${await personIdOf(coachCookie)}/co-coach/grant`,
    );
    expect(granted.status).toBe(200);

    for (const cookie of [ownerCookie, coachCookie]) {
      const response = await readCard(cookie, teamId, casey);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual(rate([], taxonomyV0, rulesV0, littleLeague));
    }
  });

  it("refuses the coach of a different team", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const otherCoachCookie = await signIn("second-adult");
    const other = await seedTeam(otherCoachCookie, "Majors Meteors");

    const viaChildTeam = await readCard(otherCoachCookie, teamId, casey);
    expect(viaChildTeam.status).toBe(404);
    expect(json(viaChildTeam)).toEqual({ error: "team not found" });
    const viaOwnTeam = await readCard(otherCoachCookie, other.teamId, casey);
    expect(viaOwnTeam.status).toBe(404);
    expect(json(viaOwnTeam)).toEqual({ error: "participant not found" });
  });

  it("refuses the coach once the child's membership is removed", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    expect((await readCard(ownerCookie, teamId, casey)).status).toBe(200);

    await sql
      .prepare("UPDATE memberships SET status = 'revoked' WHERE member_participant_id = ?")
      .run([casey]);

    const response = await readCard(ownerCookie, teamId, casey);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
  });

  it("refuses the coach once the season is no longer active", async () => {
    const ownerCookie = await signIn();
    const { teamId, seasonId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    expect((await readCard(ownerCookie, teamId, casey)).status).toBe(200);

    await sql.prepare("UPDATE seasons SET status = 'archived' WHERE id = ?").run([seasonId]);

    const response = await readCard(ownerCookie, teamId, casey);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
  });

  it("refuses a parent of a different child on the same team", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey, rowan } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const parentCookie = await signIn("second-adult");
    await joinTeam(ownerCookie, parentCookie, teamId, rowan);

    expect((await readCard(parentCookie, teamId, rowan)).status).toBe(200);
    const response = await readCard(parentCookie, teamId, casey);
    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: "participant not found" });
  });

  it("keeps lesson answers and the seed route guardian-only for a coach", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const [first] = episode.lesson.quiz;
    if (first === undefined) throw new Error("Lesson has no quiz.");

    const answered = await post(ownerCookie, `/api/teams/${teamId}/lessons/current/answers`, {
      participantId: casey,
      quizId: first.id,
      answer: first.answer,
    });
    expect(answered.status).toBe(404);
    expect(json(answered)).toEqual({ error: "participant not found" });

    const seeded = await post(ownerCookie, seedPath(teamId, casey), week(casey));
    expect(seeded.status).toBe(404);
    expect(json(seeded)).toEqual({ error: "participant not found" });
    expect(await storedEventCount()).toBe(0);
  });

  it("gives a coach the same card fields as a guardian and nothing more", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const guardianCookie = await signIn("second-adult");
    await joinTeam(ownerCookie, guardianCookie, teamId, casey);
    expect((await post(guardianCookie, seedPath(teamId, casey), week(casey))).status).toBe(200);

    const guardianCard = json(await readCard(guardianCookie, teamId, casey)) as Record<
      string,
      unknown
    >;
    const coachCard = json(await readCard(ownerCookie, teamId, casey)) as Record<string, unknown>;
    expect(Object.keys(guardianCard).toSorted()).toEqual(["areas", "explain", "overall", "skills"]);
    expect(coachCard).toEqual(guardianCard);
    expect(JSON.stringify(coachCard)).not.toContain("Casey");
  });
});

describe("development skill event seed route", () => {
  async function guardianOfCasey() {
    const ownerCookie = await signIn();
    const team = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const guardianCookie = await signIn("second-adult");
    await joinTeam(ownerCookie, guardianCookie, team.teamId, team.casey);
    return { ownerCookie, guardianCookie, ...team };
  }

  it("records a backdated week for a managing guardian and the card rates it", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const events = week(casey);

    const response = await post(guardianCookie, seedPath(teamId, casey), events);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ recorded: events.length, duplicates: 0 });

    const card = json(await readCard(guardianCookie, teamId, casey));
    expect(card).toEqual(rate(parseSkillEvents(events), taxonomyV0, rulesV0, littleLeague));
    const skills = (card as { skills: { streakAtLast: number }[] }).skills;
    expect(Math.max(...skills.map((skill) => skill.streakAtLast))).toBe(7);
  });

  it("records nothing new when the same batch is posted again", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    await post(guardianCookie, seedPath(teamId, casey), week(casey));

    const again = await post(guardianCookie, seedPath(teamId, casey), week(casey));
    expect(again.status).toBe(200);
    expect(json(again)).toEqual({ recorded: 0, duplicates: 7 });
    expect(await storedEventCount()).toBe(7);
  });

  it.each([
    ["an invalid event", (events: unknown[]) => [...events, { type: "drill_completed" }]],
    [
      "an unknown skill",
      (events: unknown[]) => [
        ...events,
        { ...(events[0] as object), id: "evt_unknown", skill: "hitting.moonshot" },
      ],
    ],
    [
      "another player's event",
      (events: unknown[]) => [
        ...events,
        { ...(events[0] as object), id: "evt_other", playerId: "plr_someoneelse" },
      ],
    ],
    [
      "a future event",
      (events: unknown[]) => [
        ...events,
        {
          ...(events[0] as object),
          id: "evt_future",
          occurredAt: new Date(NOW + DAY_MS).toISOString(),
        },
      ],
    ],
    ["a repeated event id", (events: unknown[]) => [...events, events[0]]],
  ])("rejects the whole batch for %s", async (_label, mutate) => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();

    const response = await post(guardianCookie, seedPath(teamId, casey), mutate(week(casey)));
    expect(response.status).toBe(400);
    expect(await storedEventCount()).toBe(0);
  });

  it("rejects an empty batch, a non-array body and a batch over the cap", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const oversized = Array.from({ length: DEV_SKILL_EVENTS_MAX_BATCH + 1 }, (_, index) =>
      drill(casey, index, 1, "infield.ready-position"),
    );

    for (const body of [[], { events: week(casey) }, oversized]) {
      const response = await post(guardianCookie, seedPath(teamId, casey), body);
      expect(response.status).toBe(400);
    }
    expect(await storedEventCount()).toBe(0);
  });

  it("refuses an anonymous caller and a stranger", async () => {
    const ownerCookie = await signIn();
    const { teamId, casey } = await seedTeam(ownerCookie, "Coach Pitch Comets");
    const strangerCookie = await signIn("second-adult");

    const anonymous = await app.handle("POST", seedPath(teamId, casey), {
      headers: sameOrigin,
      body: week(casey),
    });
    expect(anonymous.status).toBe(401);
    const stranger = await post(strangerCookie, seedPath(teamId, casey), week(casey));
    expect(stranger.status).toBe(404);
    expect(await storedEventCount()).toBe(0);
  });

  async function guardiansOfTwoChildren() {
    const seeded = await guardianOfCasey();
    const stamp = new Date(NOW).toISOString();
    await services.db
      .insert(guardianRelationships)
      .values({
        id: "guardian_owner_rowan",
        guardianPersonId: await personIdOf(seeded.ownerCookie),
        participantId: seeded.rowan,
        relationship: "parent",
        status: "active",
        permissions: JSON.stringify(DEFAULT_GUARDIAN_PERMISSIONS),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    const [item] = episode.lesson.quiz;
    if (item === undefined) throw new Error("Lesson has no quiz.");
    const sourceId = `${episode.lesson.seriesId}/${episode.lesson.slug}`;
    return {
      ...seeded,
      item,
      sourceId,
      rowanLessonEventId: await checkPassedEventId(seeded.rowan, sourceId, item.id),
      caseyLessonEventId: await checkPassedEventId(seeded.casey, sourceId, item.id),
    };
  }

  function answerLesson(
    cookie: string,
    teamId: string,
    participantId: string,
    quiz: { id: string; answer: number },
  ) {
    return post(cookie, `/api/teams/${teamId}/lessons/current/answers`, {
      participantId,
      quizId: quiz.id,
      answer: quiz.answer,
    });
  }

  function storedEvent(participantId: string, id: string) {
    return { id, participant_id: participantId };
  }

  it.each([
    ["before", "a drill"],
    ["before", "a check"],
    ["after", "a drill"],
    ["after", "a check"],
  ])(
    "refuses another child's lesson event id posted %s that child answers, as %s",
    async (order, form) => {
      const {
        ownerCookie,
        guardianCookie,
        teamId,
        casey,
        rowan,
        item,
        sourceId,
        rowanLessonEventId,
      } = await guardiansOfTwoChildren();
      const [firstDrill] = week(casey);
      const forged =
        form === "a drill"
          ? { ...firstDrill, id: rowanLessonEventId }
          : {
              ...firstDrill,
              id: rowanLessonEventId,
              type: "check_passed",
              source: { kind: "reel-episode", id: sourceId, itemId: item.id },
            };
      if (order === "after") {
        expect((await answerLesson(ownerCookie, teamId, rowan, item)).status).toBe(200);
      }

      const response = await post(guardianCookie, seedPath(teamId, casey), [forged]);
      expect(response.status).toBe(409);
      expect(json(response)).toEqual({
        error: "event 0 conflicts with an existing or reserved event id",
      });

      if (order === "before") {
        expect(await storedEventRows()).toEqual([]);
        expect((await answerLesson(ownerCookie, teamId, rowan, item)).status).toBe(200);
      }
      expect(await storedEventRows()).toEqual([storedEvent(rowan, rowanLessonEventId)]);
    },
  );

  interface RowanProbe {
    readonly caseyDrill: ReturnType<typeof drill>;
    readonly rowanEventId: string;
    readonly rowanLessonEventId: string;
  }

  async function probeBeforeAndAfterRowanSeeds(probe: (ids: RowanProbe) => unknown[]) {
    const { ownerCookie, guardianCookie, teamId, casey, rowan, rowanLessonEventId } =
      await guardiansOfTwoChildren();
    const rowanWeek = week(rowan);
    const body = probe({
      caseyDrill: drill(casey, 99, 1, "infield.ready-position"),
      rowanEventId: rowanWeek[1]?.id ?? "",
      rowanLessonEventId,
    });
    const send = async () => {
      const response = await post(guardianCookie, seedPath(teamId, casey), body);
      return { status: response.status, body: json(response) };
    };

    const unseeded = await send();
    expect(await storedEventRows()).toEqual([]);
    expect((await post(ownerCookie, seedPath(teamId, rowan), rowanWeek)).status).toBe(200);
    const seeded = await send();
    expect(await storedEventCount()).toBe(rowanWeek.length);
    expect((await storedEventRows()).every((row) => row.participant_id === rowan)).toBe(true);
    return { unseeded, seeded };
  }

  it("refuses an id in another child's seed range the same way whether or not it is held", async () => {
    const { unseeded, seeded } = await probeBeforeAndAfterRowanSeeds(
      ({ caseyDrill, rowanEventId }) => [{ ...caseyDrill, id: rowanEventId }],
    );

    expect(unseeded).toEqual({
      status: 400,
      body: { error: "event 0 has an id outside this player's seed id range" },
    });
    expect(seeded).toEqual(unseeded);
  });

  it("answers a foreign id followed by a reserved id the same way whether or not it is held", async () => {
    const { unseeded, seeded } = await probeBeforeAndAfterRowanSeeds(
      ({ caseyDrill, rowanEventId, rowanLessonEventId }) => [
        { ...caseyDrill, id: rowanEventId },
        { ...caseyDrill, id: rowanLessonEventId },
      ],
    );

    expect(unseeded).toEqual({
      status: 400,
      body: { error: "event 0 has an id outside this player's seed id range" },
    });
    expect(seeded).toEqual(unseeded);
  });

  it("refuses an id outside the player's seed range before reading stored events", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const [firstDrill] = week(casey);

    const response = await post(guardianCookie, seedPath(teamId, casey), [
      { ...firstDrill, id: "evt_fresh" },
    ]);
    expect(response.status).toBe(400);
    expect(await storedEventCount()).toBe(0);
  });

  it("does not let a seed range be a prefix of a longer participant's range", () => {
    expect(seedEventIdStem("participant_ab").startsWith(seedEventIdStem("participant_a"))).toBe(
      false,
    );
  });

  it("accepts the dev scenario's week for its own child and replays it as duplicates", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const events = scenarioSkillEvents(casey, NOW, "America/Los_Angeles");

    const first = await post(guardianCookie, seedPath(teamId, casey), events);
    expect(first.status).toBe(200);
    expect(json(first)).toEqual({ recorded: events.length, duplicates: 0 });
    const replay = await post(guardianCookie, seedPath(teamId, casey), events);
    expect(replay.status).toBe(200);
    expect(json(replay)).toEqual({ recorded: 0, duplicates: events.length });
  });

  function racingInserts(db: Db): Db {
    const forward = (target: Db, key: string | symbol): unknown => {
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    };
    const racingTx = (tx: Db): Db =>
      new Proxy(tx, {
        get: (target, key) =>
          key === "raw"
            ? async (sql: string, params?: readonly unknown[]) => {
                if (sql.includes("RETURNING")) await target.raw(sql, params);
                return target.raw(sql, params);
              }
            : forward(target, key),
      });
    return new Proxy(db, {
      get: (target, key) =>
        key === "transaction"
          ? <R>(fn: (tx: Db) => Promise<R>) => target.transaction((tx) => fn(racingTx(tx)))
          : forward(target, key),
    });
  }

  it("rolls back the whole batch when a fresh event's insert returns no row", async () => {
    const { casey } = await guardianOfCasey();
    const events = parseSkillEvents(week(casey));

    await expect(
      racingInserts(services.db).transaction((tx) => appendSkillEvents(tx, casey, events, NOW)),
    ).rejects.toEqual(new SkillEventInsertConflict(0));
    expect(await storedEventCount()).toBe(0);
  });

  it("answers 409 and writes nothing when a fresh event loses an insert race", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const racingApp = await createApp({
      ...config,
      app: registerDevSkillEventRoutes(
        createApplication({
          sql,
          db: services.db,
          sessions: services.sessions,
          mode: "development",
          clock,
          developmentSignIn: true,
          inviteDelivery: devInviteDeliverer(),
          invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
          lessons: { enabled: true, catalog: staticLessonCatalog([episode]) },
        }).config.app,
        { enabled: true, db: racingInserts(services.db), sessions: services.sessions, clock },
      ),
    });

    const response = await racingApp.handle("POST", seedPath(teamId, casey), {
      headers: { ...sameOrigin, cookie: guardianCookie },
      body: week(casey),
    });
    expect(response.status).toBe(409);
    expect(json(response)).toEqual({
      error: "event 0 conflicts with an existing or reserved event id",
    });
    expect(await storedEventCount()).toBe(0);
  });

  it("refuses a changed event under an id the same child already holds", async () => {
    const { guardianCookie, teamId, casey } = await guardianOfCasey();
    const events = week(casey);
    await post(guardianCookie, seedPath(teamId, casey), events);

    const response = await post(guardianCookie, seedPath(teamId, casey), [
      { ...events[0], skill: "baserunning.out-of-the-box" },
    ]);
    expect(response.status).toBe(409);
    expect(await storedEventCount()).toBe(7);
  });

  it("treats an identical replay of the child's own lesson event as a duplicate", async () => {
    const { guardianCookie, teamId, casey, item, caseyLessonEventId } =
      await guardiansOfTwoChildren();
    expect((await answerLesson(guardianCookie, teamId, casey, item)).status).toBe(200);
    const rows = (await sql
      .prepare("SELECT event FROM skill_events WHERE id = ?")
      .all([caseyLessonEventId])) as { event: string }[];
    const stored: unknown = JSON.parse(rows[0]?.event ?? "null");

    const replay = await post(guardianCookie, seedPath(teamId, casey), [stored]);
    expect(replay.status).toBe(200);
    expect(json(replay)).toEqual({ recorded: 0, duplicates: 1 });
    expect(await storedEventRows()).toEqual([storedEvent(casey, caseyLessonEventId)]);
  });

  it("refuses to register against verified sessions", async () => {
    expect(() =>
      registerDevSkillEventRoutes(config.app, {
        enabled: true,
        db: services.db,
        sessions: { ...services.sessions, mode: "verified" },
        clock,
      }),
    ).toThrow("Development skill event seeding requires development session services.");
  });
});
