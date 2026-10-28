import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CHILDREN, FALCONS, mainText, persona } from "./support/pages";
import { cardWriteRows, correctAnswer, lessonAnswersPath } from "./support/lessons";
import { FIXTURE_LESSON } from "./support/reel-fixture";
import { useScenario } from "./support/scenario";
import { asRole, refused } from "./support/session";
import type { Role } from "./support/session";

setDefaultTimeout(90_000);

const ANSWERS = lessonAnswersPath(FALCONS.teamId);
const CURRENT_LESSON = `/api/teams/${FALCONS.teamId}/lessons/current`;
const FIXTURE_TITLE = "E2E Ready Position";

interface RefusalCase {
  readonly role: Role;
  readonly who: string;
  readonly participantId: string;
  readonly child: string;
  readonly status: number;
  readonly error: string;
}

const REFUSALS: readonly RefusalCase[] = [
  {
    role: "head-coach",
    who: "the Falcons owner",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "participant not found",
  },
  {
    role: "co-coach",
    who: "the Falcons co-coach",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "participant not found",
  },
  {
    role: "team-member",
    who: "a Falcons adult with no child",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "participant not found",
  },
  {
    role: "parent",
    who: "a Falcons guardian of another family",
    participantId: CHILDREN.casey.participantId,
    child: "Casey",
    status: 404,
    error: "participant not found",
  },
  {
    role: "second-adult",
    who: "a Falcons co-coach who guards a child on another team",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "participant not found",
  },
  {
    role: "second-team-guardian",
    who: "a guardian on the Comets only",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "team not found",
  },
  {
    role: "stranger",
    who: "a signed-in adult on no team",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 404,
    error: "team not found",
  },
  {
    role: "signed-out",
    who: "a signed-out visitor",
    participantId: CHILDREN.avery.participantId,
    child: "Avery",
    status: 401,
    error: "authentication required",
  },
];

describe("lesson answers: the production card write refuses every adult who is not the child's guardian", () => {
  const scenario = useScenario();

  test("the Falcons lesson of the week is the local fixture lesson", async () => {
    await asRole(scenario(), "parent", async (session) => {
      const reply = await session.api("GET", CURRENT_LESSON);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        lesson: { seriesId: FIXTURE_LESSON.seriesId, slug: FIXTURE_LESSON.slug },
      });
    });
  });

  for (const refusal of REFUSALS) {
    test(`${refusal.role}: ${refusal.who} answers correctly for ${refusal.child} and gets ${refusal.status} with no lesson answer and no skill event`, async () => {
      const before = cardWriteRows(scenario(), refusal.participantId);
      await asRole(scenario(), refusal.role, async (session) => {
        const reply = await refused(
          session,
          "POST",
          ANSWERS,
          correctAnswer(refusal.participantId),
          [refusal.status],
        );
        expect(reply.body).toEqual({ error: refusal.error });
      });
      expect(cardWriteRows(scenario(), refusal.participantId)).toEqual(before);
    });
  }
});

describe("lesson answers: a guardian answers for their own child (parent)", () => {
  const scenario = useScenario();

  test("answers for their second child, and the same write for another family's child or a child on another team is refused (404): proves the guardian write guard", async () => {
    const blakeBefore = cardWriteRows(scenario(), CHILDREN.blake.participantId);
    const others = [CHILDREN.casey, CHILDREN.quinn] as const;
    const othersBefore = others.map((child) => cardWriteRows(scenario(), child.participantId));
    await asRole(scenario(), "parent", async (session) => {
      for (const other of others) {
        const reply = await refused(
          session,
          "POST",
          ANSWERS,
          correctAnswer(other.participantId),
          [404],
        );
        expect(reply.body).toEqual({ error: "participant not found" });
      }
      const reply = await session.api("POST", ANSWERS, correctAnswer(CHILDREN.blake.participantId));
      expect(reply.status).toBe(200);
    });
    expect(others.map((child) => cardWriteRows(scenario(), child.participantId))).toEqual(
      othersBefore,
    );
    expect(cardWriteRows(scenario(), CHILDREN.blake.participantId).answers).toEqual([
      ...blakeBefore.answers,
      expect.objectContaining({
        quiz_id: FIXTURE_LESSON.quizId,
        outcome: "correct",
        recorded_by_person_id: persona("parent").personId,
      }),
    ]);
  });

  test("the answer and its skill event are stored, and a fresh load shows the answer", async () => {
    const before = cardWriteRows(scenario(), CHILDREN.avery.participantId);
    expect(before.answers).toEqual([]);

    await asRole(scenario(), "parent", async (session) => {
      const reply = await session.api("POST", ANSWERS, correctAnswer(CHILDREN.avery.participantId));
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        answer: {
          participantId: CHILDREN.avery.participantId,
          quizId: FIXTURE_LESSON.quizId,
          outcome: "correct",
        },
      });
    });

    await asRole(scenario(), "parent", async (session) => {
      await session.open("/app");
      expect(await mainText(session.page)).toContain(FIXTURE_TITLE);
      const reply = await session.api("GET", CURRENT_LESSON);
      expect(reply.status).toBe(200);
      const progress = (
        reply.body as {
          progress: { participantId: string; answers: { quizId: string; outcome: string }[] }[];
        }
      ).progress.find((entry) => entry.participantId === CHILDREN.avery.participantId);
      expect(progress?.answers).toEqual([
        expect.objectContaining({ quizId: FIXTURE_LESSON.quizId, outcome: "correct" }),
      ]);
    });

    const after = cardWriteRows(scenario(), CHILDREN.avery.participantId);
    expect(after.answers).toEqual([
      expect.objectContaining({
        series_id: FIXTURE_LESSON.seriesId,
        episode_slug: FIXTURE_LESSON.slug,
        quiz_id: FIXTURE_LESSON.quizId,
        answer_index: FIXTURE_LESSON.correctAnswer,
        outcome: "correct",
        recorded_by_person_id: persona("parent").personId,
      }),
    ]);
    const added = after.events.filter(
      (row) => !before.events.some((previous) => previous.id === row.id),
    );
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0]?.event ?? "{}")).toMatchObject({
      type: "check_passed",
      skill: "infield.ready-position",
      source: {
        kind: "reel-episode",
        id: `${FIXTURE_LESSON.seriesId}/${FIXTURE_LESSON.slug}`,
        itemId: FIXTURE_LESSON.quizId,
      },
    });
  });
});
