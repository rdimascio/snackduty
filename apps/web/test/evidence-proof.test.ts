import { installSessionSchema } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { evaluatePolicy } from "@snackday/domain";
import type { DomainPermission } from "@snackday/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authorizationContext, proofGuard } from "../app/lib/server/authorization";
import type { AuthorizationTarget, EvidenceProof } from "../app/lib/server/authorization";
import { applicationMigrations } from "../app/lib/server/composition";

const NOW = "2026-11-24T12:00:00.000Z";
const TEAM = "team_proof";
const OTHER_TEAM = "team_proof_other";
const SEASON = "season_proof";
const CHILD = "participant_proof";
const ROSTER_ROW = "membership_proof";
const GUARDIAN_EDGE = "guardian_proof";
const BOTH_PERMISSIONS = '["participant.read","participant.manage"]';

const PEOPLE = {
  owner: "person_proof_owner",
  coach: "person_proof_coach",
  adult: "person_proof_adult",
  guardian: "person_proof_guardian",
} as const;
type Actor = keyof typeof PEOPLE;

const ADULT_ROWS = {
  owner: { id: "adult_membership_proof_owner", role: "owner" },
  coach: { id: "adult_membership_proof_coach", role: "coach" },
  adult: { id: "adult_membership_proof_adult", role: "adult" },
  guardian: { id: "adult_membership_proof_guardian", role: "adult" },
} as const;

const ROLE_DOWNGRADE = { owner: "coach", coach: "adult", adult: "viewer" } as const;

function accountId(actor: Actor) {
  return `account_${PEOPLE[actor]}`;
}

const FIXTURE_SQL = [
  ...Object.values(PEOPLE).map(
    (id) =>
      `INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES ('${id}', 'Proof adult', 'active', '${NOW}', '${NOW}')`,
  ),
  `INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES ('person_proof_child', 'Proof child', 'active', '${NOW}', '${NOW}')`,
  ...(Object.keys(PEOPLE) as Actor[]).map(
    (actor) =>
      `INSERT INTO accounts (id, person_id, status, created_at, updated_at) VALUES ('${accountId(actor)}', '${PEOPLE[actor]}', 'active', '${NOW}', '${NOW}')`,
  ),
  ...[TEAM, OTHER_TEAM].map(
    (id) =>
      `INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES ('${id}', 'Proof team', 'active', '${PEOPLE.owner}', '${NOW}', '${NOW}')`,
  ),
  `INSERT INTO seasons (id, team_id, label, start_date, end_date, time_zone, status, created_at, updated_at) VALUES ('${SEASON}', '${TEAM}', 'Proof season', '2026-09-01', '2027-06-01', 'UTC', 'active', '${NOW}', '${NOW}')`,
  ...(Object.keys(ADULT_ROWS) as Actor[]).map(
    (actor) =>
      `INSERT INTO adult_memberships (id, team_id, person_id, role, status, created_at, updated_at) VALUES ('${ADULT_ROWS[actor].id}', '${TEAM}', '${PEOPLE[actor]}', '${ADULT_ROWS[actor].role}', 'active', '${NOW}', '${NOW}')`,
  ),
  `INSERT INTO participants (id, person_id, status, created_at, updated_at) VALUES ('${CHILD}', 'person_proof_child', 'active', '${NOW}', '${NOW}')`,
  `INSERT INTO memberships (id, team_id, season_id, member_kind, member_participant_id, status, created_at, updated_at, child_identity_key) VALUES ('${ROSTER_ROW}', '${TEAM}', '${SEASON}', 'participant', '${CHILD}', 'active', '${NOW}', '${NOW}', 'proof-key')`,
  `INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at) VALUES ('${GUARDIAN_EDGE}', '${PEOPLE.guardian}', '${CHILD}', 'parent', 'active', '${BOTH_PERMISSIONS}', '${NOW}', '${NOW}')`,
];

interface Mutation {
  readonly name: string;
  readonly sql: string;
}

const MUTATIONS: readonly Mutation[] = [
  ...(Object.keys(PEOPLE) as Actor[]).flatMap((actor) => [
    {
      name: `${actor} account suspended`,
      sql: `UPDATE accounts SET status = 'suspended' WHERE id = '${accountId(actor)}'`,
    },
    {
      name: `${actor} account deleted`,
      sql: `DELETE FROM accounts WHERE id = '${accountId(actor)}'`,
    },
    {
      name: `${actor} person archived`,
      sql: `UPDATE people SET status = 'archived' WHERE id = '${PEOPLE[actor]}'`,
    },
    { name: `${actor} person deleted`, sql: `DELETE FROM people WHERE id = '${PEOPLE[actor]}'` },
  ]),
  { name: "team archived", sql: `UPDATE teams SET status = 'archived' WHERE id = '${TEAM}'` },
  {
    name: "team handed to another creator",
    sql: `UPDATE teams SET created_by_person_id = '${PEOPLE.adult}' WHERE id = '${TEAM}'`,
  },
  { name: "team deleted", sql: `DELETE FROM teams WHERE id = '${TEAM}'` },
  { name: "season archived", sql: `UPDATE seasons SET status = 'archived' WHERE id = '${SEASON}'` },
  {
    name: "season moved to another team",
    sql: `UPDATE seasons SET team_id = '${OTHER_TEAM}' WHERE id = '${SEASON}'`,
  },
  { name: "season deleted", sql: `DELETE FROM seasons WHERE id = '${SEASON}'` },
  ...(Object.keys(ADULT_ROWS) as Actor[]).flatMap((actor) => {
    const row = ADULT_ROWS[actor];
    return [
      {
        name: `${actor} adult membership revoked`,
        sql: `UPDATE adult_memberships SET status = 'revoked' WHERE id = '${row.id}'`,
      },
      {
        name: `${actor} adult membership role downgraded`,
        sql: `UPDATE adult_memberships SET role = '${ROLE_DOWNGRADE[row.role]}' WHERE id = '${row.id}'`,
      },
      {
        name: `${actor} adult membership deleted`,
        sql: `DELETE FROM adult_memberships WHERE id = '${row.id}'`,
      },
    ];
  }),
  {
    name: "child archived",
    sql: `UPDATE participants SET status = 'archived' WHERE id = '${CHILD}'`,
  },
  { name: "child deleted", sql: `DELETE FROM participants WHERE id = '${CHILD}'` },
  {
    name: "child roster membership revoked",
    sql: `UPDATE memberships SET status = 'revoked' WHERE id = '${ROSTER_ROW}'`,
  },
  {
    name: "child roster membership deleted",
    sql: `DELETE FROM memberships WHERE id = '${ROSTER_ROW}'`,
  },
  {
    name: "guardian edge revoked",
    sql: `UPDATE guardian_relationships SET status = 'revoked' WHERE id = '${GUARDIAN_EDGE}'`,
  },
  {
    name: "guardian edge loses manage",
    sql: `UPDATE guardian_relationships SET permissions = '["participant.read"]' WHERE id = '${GUARDIAN_EDGE}'`,
  },
  {
    name: "guardian edge loses every permission",
    sql: `UPDATE guardian_relationships SET permissions = '[]' WHERE id = '${GUARDIAN_EDGE}'`,
  },
  {
    name: "guardian edge deleted",
    sql: `DELETE FROM guardian_relationships WHERE id = '${GUARDIAN_EDGE}'`,
  },
];

const season = { teamId: TEAM, seasonId: SEASON };
const child = { ...season, participantId: CHILD };

interface AllowedCase {
  readonly actor: Actor;
  readonly permission: DomainPermission;
  readonly target: AuthorizationTarget;
}

const ALLOWED_CASES: readonly AllowedCase[] = [
  { actor: "adult", permission: "team.read", target: { teamId: TEAM } },
  { actor: "guardian", permission: "team.read", target: { teamId: TEAM } },
  { actor: "adult", permission: "season.read", target: season },
  { actor: "owner", permission: "team.operations.manage", target: { teamId: TEAM } },
  { actor: "coach", permission: "team.operations.manage", target: { teamId: TEAM } },
  { actor: "coach", permission: "team.operations.manage", target: season },
  { actor: "owner", permission: "participant.manage", target: child },
  { actor: "coach", permission: "participant.manage", target: child },
  { actor: "guardian", permission: "participant.manage", target: child },
];

let sql: SqlDatabase;
let db: Db;
let close: () => void;

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  sql = opened.db;
  close = opened.close;
  await installSessionSchema(sql);
  await new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
  db = createDb(sql);
  await sql.exec("PRAGMA foreign_keys = OFF");
  for (const statement of FIXTURE_SQL) await sql.exec(statement);
});

afterAll(() => close());

async function decide(actor: Actor, permission: DomainPermission, target: AuthorizationTarget) {
  const evidence = await authorizationContext(db, PEOPLE[actor], target);
  return {
    evidence,
    allowed:
      evidence !== undefined &&
      evaluatePolicy(evidence.actor, permission, evidence.context).allowed,
  };
}

async function proofHolds(proof: EvidenceProof): Promise<boolean> {
  const guard = proofGuard(proof);
  const row = (await sql
    .prepare(`SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS holds`)
    .get([...guard.params])) as { holds: number };
  return row.holds === 1;
}

async function underMutation<T>(mutation: Mutation, run: () => Promise<T>): Promise<T> {
  await sql.exec("SAVEPOINT evidence_mutation");
  try {
    await sql.exec(mutation.sql);
    return await run();
  } finally {
    await sql.exec("ROLLBACK TO evidence_mutation");
    await sql.exec("RELEASE evidence_mutation");
  }
}

describe("the evidence proof fails whenever a single-row change flips the policy to deny", () => {
  for (const allowed of ALLOWED_CASES) {
    const label = `${allowed.actor} ${allowed.permission} on ${Object.keys(allowed.target).join("+")}`;

    it(`${label}: the proof holds on the unchanged evidence`, async () => {
      const before = await decide(allowed.actor, allowed.permission, allowed.target);
      expect(before.allowed).toBe(true);
      expect(await proofHolds(before.evidence?.proof ?? [])).toBe(true);
    });

    it(`${label}: every denying mutation breaks the proof`, async () => {
      const before = await decide(allowed.actor, allowed.permission, allowed.target);
      if (before.evidence === undefined) throw new Error("The allowed fixture has no evidence.");
      const proof = before.evidence.proof;

      const denying: string[] = [];
      const missed: string[] = [];
      for (const mutation of MUTATIONS) {
        await underMutation(mutation, async () => {
          const after = await decide(allowed.actor, allowed.permission, allowed.target);
          if (after.allowed) return;
          denying.push(mutation.name);
          if (await proofHolds(proof)) missed.push(mutation.name);
        });
      }

      expect(denying.length).toBeGreaterThan(0);
      expect(missed).toEqual([]);
      expect(await proofHolds(proof)).toBe(true);
    });
  }
});
