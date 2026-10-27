import { and, eq, inList } from "@lesto/db";
import type { Db } from "@lesto/db";

import type { Clock } from "../lib/server/application-contracts";
import { calendarFeedTokens } from "../lib/server/calendar-feeds";
import { accounts, people } from "../lib/server/identity";
import { invitations, projectedInvitationStatus } from "../lib/server/invitations";
import {
  adultMemberships,
  grantedAccess,
  ownedActiveTeam,
  readableActiveTeam,
  teamAccess,
} from "../lib/server/teams";
import type { TeamRole } from "../lib/server/teams";

export interface TeamMember {
  readonly personId: string;
  readonly displayName: string;
  readonly role: TeamRole;
  readonly creator: boolean;
}

export interface TeamInvitation {
  readonly id: string;
  readonly inviteeLabel: string;
  readonly invitedRole: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly forChild: boolean;
}

export interface CalendarFeedStatus {
  readonly active: boolean;
}

const roleOrder: Readonly<Record<TeamRole, number>> = { owner: 0, coach: 1, adult: 2 };

export async function loadTeamMembers(
  db: Db,
  teamId: string,
  viewerPersonId: string,
): Promise<TeamMember[] | undefined> {
  const access = await teamAccess(db, teamId, viewerPersonId);
  if (access === undefined) return undefined;

  const membershipRows = await db
    .select()
    .from(adultMemberships)
    .where(and(eq(adultMemberships.teamId, access.team.id), eq(adultMemberships.status, "active")))
    .all();
  const rolesByPerson = new Map<string, string[]>([[access.team.createdByPersonId, ["owner"]]]);
  for (const row of membershipRows) {
    rolesByPerson.set(row.personId, [...(rolesByPerson.get(row.personId) ?? []), row.role]);
  }

  const personIds = [...rolesByPerson.keys()];
  const personRows = await db
    .select()
    .from(people)
    .where(and(inList(people.id, personIds), eq(people.status, "active")))
    .all();
  const accountRows = await db
    .select()
    .from(accounts)
    .where(and(inList(accounts.personId, personIds), eq(accounts.status, "active")))
    .all();
  const activeAccountPeople = new Set(accountRows.map((account) => account.personId));

  const members: TeamMember[] = [];
  for (const person of personRows) {
    if (!activeAccountPeople.has(person.id)) continue;
    const held = grantedAccess(rolesByPerson.get(person.id) ?? []);
    if (held === undefined) continue;
    members.push({
      personId: person.id,
      displayName: person.displayName,
      role: held.role,
      creator: person.id === access.team.createdByPersonId,
    });
  }
  members.sort(
    (left, right) =>
      roleOrder[left.role] - roleOrder[right.role] ||
      left.displayName.localeCompare(right.displayName) ||
      left.personId.localeCompare(right.personId),
  );
  return members;
}

export async function loadTeamInvitations(
  db: Db,
  teamId: string,
  viewerPersonId: string,
  clock: Clock,
): Promise<TeamInvitation[] | undefined> {
  const team = await ownedActiveTeam(db, teamId, viewerPersonId);
  if (team === undefined) return undefined;

  const rows = await db.select().from(invitations).where(eq(invitations.teamId, team.id)).all();
  rows.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const nowIso = new Date(clock()).toISOString();
  return rows.map((row) => ({
    id: row.id,
    inviteeLabel: row.inviteeLabel,
    invitedRole: row.invitedRole,
    status: projectedInvitationStatus(row, nowIso),
    expiresAt: row.expiresAt,
    forChild: row.participantId !== null,
  }));
}

export async function loadCalendarFeedStatus(
  db: Db,
  teamId: string,
  viewerPersonId: string,
): Promise<CalendarFeedStatus | undefined> {
  const team = await readableActiveTeam(db, teamId, viewerPersonId);
  if (team === undefined) return undefined;

  const row = await db
    .select()
    .from(calendarFeedTokens)
    .where(
      and(
        eq(calendarFeedTokens.teamId, team.id),
        eq(calendarFeedTokens.personId, viewerPersonId),
        eq(calendarFeedTokens.status, "active"),
      ),
    )
    .get();
  return { active: row !== undefined };
}
