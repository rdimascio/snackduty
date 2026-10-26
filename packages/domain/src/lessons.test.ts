import { describe, expect, it } from "vitest";
import {
  accountSchema,
  membershipSchema,
  PILOT_AGE_BAND,
  publicLesson,
  resolveLessonAgeBand,
  roleSchema,
  seasonIdSchema,
  seasonLessonAgeBandInputSchema,
  seasonSchema,
  teamIdSchema,
} from "./index";
import type { Lesson } from "./index";
import { evaluatePolicy } from "./policies";
import type { PolicyContext } from "./policies";

const meta = { createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" };
const account = accountSchema.parse({
  id: "account_adult",
  personId: "person_adult",
  status: "active",
  ...meta,
});
const actor = { accountId: account.id, personId: account.personId };
const teamId = teamIdSchema.parse("team_band");
const seasonId = seasonIdSchema.parse("season_band");

function persistedTeam(role: string): PolicyContext {
  return {
    account,
    target: { teamId, seasonId },
    team: { id: teamId, status: "active", createdByPersonId: actor.personId },
    season: { id: seasonId, teamId, status: "active" },
    teamMemberships: [{ teamId, personId: actor.personId, role, status: "active" }],
    memberships: [],
    guardianRelationships: [],
    roles: [],
  };
}

function seasonRole(kind: "manager" | "coach" | "guardian"): PolicyContext {
  const role = roleSchema.parse({
    id: `role_${kind}`,
    teamId,
    seasonId,
    kind,
    name: kind,
    permissions:
      kind === "manager"
        ? ["season.lessons.manage", "team.read"]
        : ["team.read", "season.read", "participant.read"],
    status: "active",
    ...meta,
  });
  return {
    account,
    target: { teamId, seasonId },
    memberships: [
      membershipSchema.parse({
        id: `membership_${kind}`,
        teamId,
        seasonId,
        member: { kind: "person", personId: actor.personId },
        roleIds: [role.id],
        status: "active",
        ...meta,
      }),
    ],
    roles: [role],
    guardianRelationships: [],
  };
}

describe("season lesson age band", () => {
  it("is managed only by a league manager role, never by a team owner, coach, or adult", () => {
    for (const role of ["owner", "coach", "adult"]) {
      expect(evaluatePolicy(actor, "season.lessons.manage", persistedTeam(role)).allowed).toBe(
        false,
      );
    }
    expect(evaluatePolicy(actor, "season.lessons.manage", seasonRole("manager")).allowed).toBe(
      true,
    );
    expect(evaluatePolicy(actor, "season.lessons.manage", seasonRole("coach")).allowed).toBe(false);
    expect(evaluatePolicy(actor, "season.lessons.manage", seasonRole("guardian")).allowed).toBe(
      false,
    );
  });

  it("falls back to the pilot band when a season has none", () => {
    expect(resolveLessonAgeBand(undefined)).toEqual({ min: 5, max: 7 });
    expect(resolveLessonAgeBand(undefined)).toBe(PILOT_AGE_BAND);
    expect(resolveLessonAgeBand({ min: 8, max: 10 })).toEqual({ min: 8, max: 10 });
  });

  it("accepts a band or null on input and keeps the band optional on the season", () => {
    expect(seasonLessonAgeBandInputSchema.parse({ lessonAgeBand: { min: 8, max: 10 } })).toEqual({
      lessonAgeBand: { min: 8, max: 10 },
    });
    expect(seasonLessonAgeBandInputSchema.parse({ lessonAgeBand: null })).toEqual({
      lessonAgeBand: null,
    });
    expect(
      seasonLessonAgeBandInputSchema.safeParse({ lessonAgeBand: { min: 9, max: 6 } }).success,
    ).toBe(false);
    const season = {
      id: seasonId,
      teamId,
      label: "Fall",
      startDate: "2026-09-01",
      endDate: "2026-12-01",
      timeZone: "UTC",
      status: "active",
      ...meta,
    };
    expect(seasonSchema.parse(season)).not.toHaveProperty("lessonAgeBand");
    expect(seasonSchema.parse({ ...season, lessonAgeBand: { min: 8, max: 10 } })).toMatchObject({
      lessonAgeBand: { min: 8, max: 10 },
    });
  });
});

describe("public lesson", () => {
  it("drops the answer key from every quiz item", () => {
    const lesson: Lesson = {
      seriesId: "blooper",
      seriesTitle: "Blooper",
      slug: "run-to-first",
      number: 2,
      title: "Run to First",
      ages: { min: 5, max: 7 },
      pageUrl: "https://example.com/run",
      posterUrl: "https://example.com/run.jpg",
      durationSeconds: 90,
      quiz: [
        {
          id: "which-way",
          prompt: "Which way?",
          choices: ["First", "Third"],
          answer: 0,
          feedback: { correct: "Yes", wrong: "Not quite" },
        },
      ],
    };
    const projected = publicLesson(lesson);
    expect(projected.quiz[0]).toEqual({
      id: "which-way",
      prompt: "Which way?",
      choices: ["First", "Third"],
      feedback: { correct: "Yes", wrong: "Not quite" },
    });
    expect(JSON.stringify(projected)).not.toContain('"answer"');
  });
});
