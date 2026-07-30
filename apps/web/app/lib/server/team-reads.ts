import type { Sessions } from "@lesto/auth";
import { and, eq, inList } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { seasonSchema } from "@snackday/domain";

import { authenticatedAdult, people } from "./identity";
import {
  guardianRelationships,
  memberships,
  ownedActiveTeam,
  participants,
  projectGuardian,
  projectParticipant,
} from "./roster";
import { projectTeam, seasons, teams } from "./teams";

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;

// Every person referenced by a roster row exists by foreign key; a miss here is
// data corruption, surfaced as a plain 500 with no child data in the message.
function requirePerson<T>(peopleById: Map<string, T>, personId: string): T {
  const person = peopleById.get(personId);
  if (person === undefined) throw new Error("Roster person record is missing.");
  return person;
}

async function listTeams(c: Context<"/api/teams">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const teamRows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.createdByPersonId, identity.person.id), eq(teams.status, "active")))
    .all();
  teamRows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  const seasonRows =
    teamRows.length === 0
      ? []
      : await db
          .select()
          .from(seasons)
          .where(
            inList(
              seasons.teamId,
              teamRows.map((team) => team.id),
            ),
          )
          .all();
  seasonRows.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
  );

  return c.json({
    teams: teamRows.map((team) => ({
      team: projectTeam(team),
      seasons: seasonRows
        .filter((season) => season.teamId === team.id)
        .map((season) => seasonSchema.parse(season)),
    })),
  });
}

async function activeSeasonParticipants(db: Db, teamId: string, seasonId: string) {
  const membershipRows = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.seasonId, seasonId),
        eq(memberships.memberKind, "participant"),
        eq(memberships.status, "active"),
      ),
    )
    .all();
  const memberParticipantIds = membershipRows
    .map((membership) => membership.memberParticipantId)
    .filter((participantId): participantId is string => participantId !== null);
  if (memberParticipantIds.length === 0) return [];

  return db
    .select()
    .from(participants)
    .where(and(inList(participants.id, memberParticipantIds), eq(participants.status, "active")))
    .all();
}

function activeGuardianEdges(db: Db, participantIds: string[]) {
  return db
    .select()
    .from(guardianRelationships)
    .where(
      and(
        inList(guardianRelationships.participantId, participantIds),
        eq(guardianRelationships.status, "active"),
      ),
    )
    .all();
}

async function loadRoster(db: Db, teamId: string, seasonId: string) {
  const participantRows = await activeSeasonParticipants(db, teamId, seasonId);
  if (participantRows.length === 0) return [];

  const guardianRows = await activeGuardianEdges(
    db,
    participantRows.map((participant) => participant.id),
  );
  const personRows = await db
    .select()
    .from(people)
    .where(
      inList(people.id, [
        ...participantRows.map((participant) => participant.personId),
        ...guardianRows.map((guardian) => guardian.guardianPersonId),
      ]),
    )
    .all();
  const peopleById = new Map(personRows.map((person) => [person.id, person] as const));

  const roster = participantRows.map((participant) => {
    const guardians = guardianRows
      .filter((guardian) => guardian.participantId === participant.id)
      .map((guardian) =>
        projectGuardian(guardian, requirePerson(peopleById, guardian.guardianPersonId)),
      );
    guardians.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.guardianId.localeCompare(right.guardianId),
    );

    return {
      ...projectParticipant(participant, requirePerson(peopleById, participant.personId)),
      guardians,
    };
  });
  roster.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      left.participantId.localeCompare(right.participantId),
  );

  return roster;
}

async function readRoster(
  c: Context<"/api/teams/:teamId/seasons/:seasonId/roster">,
  db: Db,
  sessions: Sessions,
) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  const team = await ownedActiveTeam(db, c.param("teamId"), identity.person.id);
  if (team === undefined) return c.json(teamNotFound, 404);

  const season = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, c.param("seasonId")), eq(seasons.teamId, team.id)))
    .get();
  if (season === undefined) return c.json(teamNotFound, 404);

  return c.json({ roster: await loadRoster(db, team.id, season.id) });
}

export function registerTeamReadRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .get("/api/teams", (c) => listTeams(c, db, sessions))
    .get("/api/teams/:teamId/seasons/:seasonId/roster", (c) => readRoster(c, db, sessions));
}
