import type { Sessions } from "@lesto/auth";
import { and, eq, inList } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { Context, Lesto } from "@lesto/web";
import { guardianRelationshipSchema, seasonSchema } from "@snackday/domain";

import { authenticatedAdult, people } from "./identity";
import { invitations, projectedInvitationStatus } from "./invitations";
import {
  activeSeasonParticipantRows,
  guardianRelationships,
  projectGuardian,
  projectParticipant,
} from "./roster";
import { adultMemberships, grantedAccess, projectTeam, seasons, teamAccess, teams } from "./teams";
import type { TeamAccessLevel } from "./teams";

const unauthorized = { error: "authentication required" } as const;
const teamNotFound = { error: "team not found" } as const;

// Every person referenced by a roster row exists by foreign key; a miss here is
// data corruption, surfaced as a plain 500 with no child data in the message.
function requirePerson<T>(peopleById: Map<string, T>, personId: string): T {
  const person = peopleById.get(personId);
  if (person === undefined) throw new Error("Roster person record is missing.");
  return person;
}

// The one team-list projection: `GET /api/teams` AND the /app page loader both
// read through here, so the page and the API cannot drift. A team is listed
// when the person CREATED it or holds an ACTIVE adult membership on it, and
// each entry carries its access level — "manage" for creators and owner-role
// members, "read" for adult-role members — so surfaces can render read-only
// versus management affordances without re-deriving authorization.
export async function listAccessibleTeams(db: Db, personId: string) {
  const createdRows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.createdByPersonId, personId), eq(teams.status, "active")))
    .all();

  const membershipRows = await db
    .select()
    .from(adultMemberships)
    .where(and(eq(adultMemberships.personId, personId), eq(adultMemberships.status, "active")))
    .all();
  const rolesByTeamId = new Map<string, string[]>();
  for (const membership of membershipRows) {
    const roles = rolesByTeamId.get(membership.teamId);
    if (roles === undefined) rolesByTeamId.set(membership.teamId, [membership.role]);
    else roles.push(membership.role);
  }
  // The SAME fold `teamAccess` authorizes with — owner outranks adult, unknown
  // roles grant nothing — so this list and the authorization seam agree by
  // construction rather than by two copies of the rule staying in sync.
  const accessByTeamId = new Map<string, TeamAccessLevel>();
  for (const [teamId, roles] of rolesByTeamId) {
    const granted = grantedAccess(roles);
    if (granted !== undefined) accessByTeamId.set(teamId, granted.level);
  }
  // Creator authority is implicit (no membership row required) and manages.
  for (const team of createdRows) accessByTeamId.set(team.id, "manage");

  const createdIds = new Set(createdRows.map((team) => team.id));
  const memberTeamIds = [...accessByTeamId.keys()].filter((teamId) => !createdIds.has(teamId));
  const memberRows =
    memberTeamIds.length === 0
      ? []
      : await db
          .select()
          .from(teams)
          .where(and(inList(teams.id, memberTeamIds), eq(teams.status, "active")))
          .all();

  const teamRows = [...createdRows, ...memberRows];
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

  return teamRows.map((team) => ({
    team: projectTeam(team),
    seasons: seasonRows
      .filter((season) => season.teamId === team.id)
      .map((season) => seasonSchema.parse(season)),
    // Every listed team has an entry by construction; "read" is the
    // never-granting-more fallback the types demand.
    access: accessByTeamId.get(team.id) ?? "read",
  }));
}

async function listTeams(c: Context<"/api/teams">, db: Db, sessions: Sessions) {
  const identity = await authenticatedAdult(db, sessions, c.header("cookie"));
  if (identity === undefined) return c.json(unauthorized, 401);

  return c.json({ teams: await listAccessibleTeams(db, identity.person.id) });
}

function activeGuardianEdges(db: Db, participantIds: string[], guardianPersonId?: string) {
  return db
    .select()
    .from(guardianRelationships)
    .where(
      and(
        inList(guardianRelationships.participantId, participantIds),
        eq(guardianRelationships.status, "active"),
        ...(guardianPersonId === undefined
          ? []
          : [eq(guardianRelationships.guardianPersonId, guardianPersonId)]),
      ),
    )
    .all();
}

/** Per-child invitation state, as the roster projection reports it. */
interface GuardianInvitationCounts {
  pending: number;
  expired: number;
  accepted: number;
}

function emptyInvitationCounts(): GuardianInvitationCounts {
  return { pending: 0, expired: 0, accepted: 0 };
}

/**
 * How many guardian invitations each child on this roster has out, by the state
 * a READER is shown — pending, expired (pending past its expiry: the same rule
 * the invitation list and the accept path apply), or accepted.
 *
 * COUNTS ONLY, on purpose. The invitation row carries two things this projection
 * must never surface: the invitee LABEL (the inviter's own wording, which
 * routinely quotes a child — "Maya's dad") and the token that reaches the
 * invitation list. A manager gets what they need here ("this child still has
 * nobody accepted") and reads the labelled list through the owner-scoped
 * invitations endpoint, which authorizes with `manageableActiveTeam`.
 *
 * Revoked invitations are deliberately not counted: a withdrawn invitation is
 * not a state of the child's roster entry.
 */
async function guardianInvitationCounts(
  db: Db,
  teamId: string,
  participantIds: string[],
): Promise<Map<string, GuardianInvitationCounts>> {
  const counts = new Map<string, GuardianInvitationCounts>(
    participantIds.map((participantId) => [participantId, emptyInvitationCounts()] as const),
  );
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.teamId, teamId), inList(invitations.participantId, participantIds)))
    .all();

  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const bucket = row.participantId === null ? undefined : counts.get(row.participantId);
    if (bucket === undefined) continue;

    const status = projectedInvitationStatus(row, nowIso);
    if (status === "pending") bucket.pending += 1;
    else if (status === "expired") bucket.expired += 1;
    else if (status === "accepted") bucket.accepted += 1;
  }

  return counts;
}

export interface RosterViewer {
  readonly personId: string;
  readonly access: TeamAccessLevel;
}

type ParticipantProjection = ReturnType<typeof projectParticipant>;

/** The stable roster DTO. Empty guardians keep existing mobile decoders valid. */
export type RosterEntry = Omit<ParticipantProjection, "birthDate"> & {
  readonly birthDate?: ParticipantProjection["birthDate"];
  readonly guardians: readonly ReturnType<typeof projectGuardian>[];
  readonly guardianInvitations?: GuardianInvitationCounts;
};

function canReadParticipant(edge: { permissions: string }): boolean {
  return guardianRelationshipSchema.shape.permissions
    .parse(JSON.parse(edge.permissions) as unknown)
    .includes("participant.read");
}

/**
 * The one privacy-aware roster projection: the roster API and /app page loader
 * both read through here after deriving `viewer` on the server. Managers may
 * inspect every child's private fields. A read-only adult gets the minimal
 * player list, except that an ACTIVE guardian edge carrying participant.read
 * restores the private fields for that guardian's own child.
 *
 * The narrower reader path also limits the guardian and invitation queries to
 * those authorized participant ids, so another child's private rows are never
 * loaded merely to remove them from the response later.
 */
export async function loadRoster(
  db: Db,
  teamId: string,
  seasonId: string,
  viewer: RosterViewer,
): Promise<RosterEntry[]> {
  const participantRows = await activeSeasonParticipantRows(db, teamId, seasonId);
  if (participantRows.length === 0) return [];

  const participantIds = participantRows.map((participant) => participant.id);
  const readableParticipantIds =
    viewer.access === "manage"
      ? new Set(participantIds)
      : new Set(
          (await activeGuardianEdges(db, participantIds, viewer.personId))
            .filter((edge) => canReadParticipant(edge))
            .map((edge) => edge.participantId),
        );
  const privateParticipantIds = [...readableParticipantIds];
  const guardianRows =
    privateParticipantIds.length === 0 ? [] : await activeGuardianEdges(db, privateParticipantIds);
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
  const invitationCounts =
    privateParticipantIds.length === 0
      ? new Map<string, GuardianInvitationCounts>()
      : await guardianInvitationCounts(db, teamId, privateParticipantIds);

  const roster = participantRows.map((participant): RosterEntry => {
    const projected = projectParticipant(
      participant,
      requirePerson(peopleById, participant.personId),
    );
    if (!readableParticipantIds.has(participant.id)) {
      const { birthDate: _privateBirthDate, ...minimal } = projected;
      return { ...minimal, guardians: [] };
    }

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
      ...projected,
      guardians,
      guardianInvitations:
        invitationCounts.get(participant.id) ??
        (emptyInvitationCounts() as GuardianInvitationCounts),
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

  const access = await teamAccess(db, c.param("teamId"), identity.person.id);
  if (access === undefined) return c.json(teamNotFound, 404);

  const season = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.id, c.param("seasonId")), eq(seasons.teamId, access.team.id)))
    .get();
  if (season === undefined) return c.json(teamNotFound, 404);

  return c.json({
    roster: await loadRoster(db, access.team.id, season.id, {
      personId: identity.person.id,
      access: access.level,
    }),
  });
}

export function registerTeamReadRoutes(app: Lesto, db: Db, sessions: Sessions) {
  return app
    .get("/api/teams", (c) => listTeams(c, db, sessions))
    .get("/api/teams/:teamId/seasons/:seasonId/roster", (c) => readRoster(c, db, sessions));
}
