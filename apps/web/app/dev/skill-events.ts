import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { skillEventSchema, taxonomyV0 } from "@snackday/skill-engine";
import type { SkillEvent } from "@snackday/skill-engine";

import type { Clock, SessionService as Sessions } from "../lib/server/application-contracts";
import { authenticatedAdult } from "../lib/server/identity";
import { teamAccess } from "../lib/server/teams";
import { mayManageParticipant } from "../lessons/lessons";
import { appendSkillEvents, playerIdFor } from "../skills/skill-events";

export const DEV_SKILL_EVENTS_PATH =
  "/api/dev/teams/:teamId/participants/:participantId/skill-events";
export const DEV_SKILL_EVENTS_MAX_BATCH = 100;

export interface DevSkillEventOptions {
  readonly enabled: boolean;
  readonly db: Db;
  readonly sessions: Sessions;
  readonly clock: Clock;
}

type BatchResult =
  | { readonly ok: true; readonly events: readonly SkillEvent[] }
  | { readonly ok: false; readonly error: string };

const knownSkills = new Set<string>(taxonomyV0.skills.map((skill) => skill.id));

function invalidEvent(index: number, reason: string): BatchResult {
  return { ok: false, error: `event ${index} ${reason}` };
}

export function parseDevSkillEventBatch(
  body: unknown,
  participantId: string,
  nowMs: number,
): BatchResult {
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, error: "request body must be a non-empty array of skill events" };
  }
  if (body.length > DEV_SKILL_EVENTS_MAX_BATCH) {
    return { ok: false, error: `batch exceeds ${DEV_SKILL_EVENTS_MAX_BATCH} events` };
  }
  const playerId = playerIdFor(participantId);
  const ids = new Set<string>();
  const events: SkillEvent[] = [];
  for (const [index, candidate] of body.entries()) {
    const parsed = skillEventSchema.safeParse(candidate);
    if (!parsed.success) return invalidEvent(index, "is not a valid skill.events/v0 event");
    const event = parsed.data;
    if ("skill" in event && !knownSkills.has(event.skill)) {
      return invalidEvent(index, "names an unknown skill");
    }
    if (event.playerId !== playerId) return invalidEvent(index, "belongs to another player");
    if (Date.parse(event.occurredAt) > nowMs) return invalidEvent(index, "occurs in the future");
    if (ids.has(event.id)) return invalidEvent(index, "repeats an event id");
    ids.add(event.id);
    events.push(event);
  }
  return { ok: true, events };
}

async function seedSkillEvents(
  c: Context<typeof DEV_SKILL_EVENTS_PATH>,
  options: DevSkillEventOptions,
) {
  const identity = await authenticatedAdult(options.db, options.sessions, c.header("cookie"));
  if (identity === undefined) return c.json({ error: "authentication required" }, 401);
  const personId = identity.person.id;
  const participantId = c.param("participantId");
  return options.db.transaction(async (tx) => {
    const access = await teamAccess(tx, c.param("teamId"), personId);
    if (access === undefined) return c.json({ error: "team not found" }, 404);
    if (!(await mayManageParticipant(tx, personId, access.team.id, participantId))) {
      return c.json({ error: "participant not found" }, 404);
    }
    const nowMs = options.clock();
    const batch = parseDevSkillEventBatch(c.req.body, participantId, nowMs);
    if (!batch.ok) return c.json({ error: batch.error }, 400);
    const outcome = await appendSkillEvents(tx, participantId, batch.events, nowMs);
    if (!outcome.ok) {
      return c.json(
        { error: `event ${outcome.conflictIndex} conflicts with an existing or reserved event id` },
        409,
      );
    }
    return c.json({ recorded: outcome.recorded, duplicates: outcome.duplicates });
  });
}

export function registerDevSkillEventRoutes(app: Lesto, options: DevSkillEventOptions): Lesto {
  if (!options.enabled) return app;
  if (options.sessions.mode !== "development") {
    throw new Error("Development skill event seeding requires development session services.");
  }
  return app.post(DEV_SKILL_EVENTS_PATH, (c) => seedSkillEvents(c, options));
}
