import { readFile } from "node:fs/promises";

import { installSessionSchema } from "@lesto/auth";
import type { Db, SqlDatabase } from "@lesto/db";
import { createApp } from "@lesto/kernel";
import { Migrator } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { seedFiles } from "../app/dev/seed-database";
import { SEED_CHILDREN, SEED_TEAMS } from "../app/dev/seed-personas";
import { applicationMigrations, createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import { storedChildIdentityKey, storedGuardianNameKey } from "../app/lib/server/people-identity";
import {
  addRosterNameKeys,
  isRosterNameKeyConflict,
  ROSTER_NAME_KEY_CONFLICT,
  RosterNameKeyConflictError,
  withRosterNameKeyBackstop,
} from "../app/lib/server/roster-name-keys";

const handles: (() => void)[] = [];

afterEach(() => {
  for (const close of handles.splice(0)) close();
});

const NOW = "2026-11-23T12:00:00.000Z";
const sameOrigin = { "sec-fetch-site": "same-origin" };
const { avery, casey } = SEED_CHILDREN;
const falconsSeason = SEED_TEAMS.coached.seasonId;
const falconsTeam = SEED_TEAMS.coached.teamId;
const DECOMPOSED_E_ACUTE = "é";
const PRECOMPOSED_E_ACUTE = "é";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

async function rows<T>(sql: SqlDatabase, query: string, params: unknown[] = []): Promise<T[]> {
  return (await sql.prepare(query).all(params)) as T[];
}

async function openDatabase(): Promise<SqlDatabase> {
  const { db, close } = await openSqlite(":memory:");
  handles.push(close);
  await installSessionSchema(db);
  return db;
}

/** A database on the last schema before the name keys, holding the SQL dev seed. */
async function seededBeforeNameKeys(): Promise<SqlDatabase> {
  const sql = await openDatabase();
  const before = applicationMigrations.filter(
    (migration) => migration.version !== addRosterNameKeys.version,
  );
  await new Migrator(sql, before, { dialect: "sqlite" }).migrate();
  for (const file of await seedFiles()) await sql.exec(await readFile(file, "utf8"));
  return sql;
}

async function migrateAll(sql: SqlDatabase): Promise<string[]> {
  return new Migrator(sql, applicationMigrations, { dialect: "sqlite" }).migrate();
}

async function insertChild(
  sql: SqlDatabase,
  input: {
    id: string;
    displayName: string;
    birthDate: string | null;
    seasonId?: string;
    teamId?: string;
    status?: string;
    key?: string | null;
  },
  withKey: boolean,
) {
  await sql
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run([`person_${input.id}`, input.displayName, NOW, NOW]);
  await sql
    .prepare(
      "INSERT INTO participants (id, person_id, birth_date, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    )
    .run([`participant_${input.id}`, `person_${input.id}`, input.birthDate, NOW, NOW]);
  const columns = withKey ? ", child_identity_key" : "";
  const values = withKey ? ", ?" : "";
  await sql
    .prepare(
      `INSERT INTO memberships (id, team_id, season_id, member_kind, member_participant_id, status, created_at, updated_at${columns}) VALUES (?, ?, ?, 'participant', ?, ?, ?, ?${values})`,
    )
    .run([
      `membership_${input.id}`,
      input.teamId ?? falconsTeam,
      input.seasonId ?? falconsSeason,
      `participant_${input.id}`,
      input.status ?? "active",
      NOW,
      NOW,
      ...(withKey ? [input.key ?? null] : []),
    ]);
}

async function insertPlaceholderGuardian(
  sql: SqlDatabase,
  input: { id: string; displayName: string; participantId: string; relationship: string },
  key?: string | null,
) {
  await sql
    .prepare(
      "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run([`person_${input.id}`, input.displayName, NOW, NOW]);
  const columns = key === undefined ? "" : ", guardian_name_key";
  const values = key === undefined ? "" : ", ?";
  await sql
    .prepare(
      `INSERT INTO guardian_relationships (id, guardian_person_id, participant_id, relationship, status, permissions, created_at, updated_at${columns}) VALUES (?, ?, ?, ?, 'active', '["participant.read"]', ?, ?${values})`,
    )
    .run([
      `guardian_relationship_${input.id}`,
      `person_${input.id}`,
      input.participantId,
      input.relationship,
      NOW,
      NOW,
      ...(key === undefined ? [] : [key]),
    ]);
}

async function columnNames(sql: SqlDatabase, table: string): Promise<string[]> {
  return (await rows<{ name: string }>(sql, `PRAGMA table_info(${table})`)).map((row) => row.name);
}

describe("the roster name key migration", () => {
  it("backfills every key from the existing rows, then creates both indexes", async () => {
    const sql = await seededBeforeNameKeys();
    await insertChild(
      sql,
      { id: "accented", displayName: `Ren${DECOMPOSED_E_ACUTE}  Kid`, birthDate: null },
      false,
    );

    expect(await migrateAll(sql)).toEqual([addRosterNameKeys.version]);

    const children = await rows<{ display_name: string; birth_date: string | null; key: string }>(
      sql,
      "SELECT people.display_name, participants.birth_date, memberships.child_identity_key AS key FROM memberships JOIN participants ON participants.id = memberships.member_participant_id JOIN people ON people.id = participants.person_id",
    );
    expect(children.length).toBe(Object.keys(SEED_CHILDREN).length + 1);
    for (const child of children) {
      expect(child.key).toMatch(SHA256_HEX);
      expect(child.key).toBe(
        await storedChildIdentityKey({
          displayName: child.display_name,
          birthDate: child.birth_date,
        }),
      );
    }
    expect(children.find((child) => child.birth_date === null)?.key).toBe(
      await storedChildIdentityKey({ displayName: `ren${PRECOMPOSED_E_ACUTE} kid` }),
    );

    const guardians = await rows<{ id: string; key: string | null }>(
      sql,
      "SELECT id, guardian_name_key AS key FROM guardian_relationships ORDER BY id",
    );
    expect(guardians.find((edge) => edge.id.includes("placeholder"))?.key).toBe(
      await storedGuardianNameKey("Morgan Placeholder"),
    );
    expect(
      guardians.filter((edge) => !edge.id.includes("placeholder")).map((edge) => edge.key),
    ).toEqual([null, null, null, null]);

    const indexes = await rows<{ name: string }>(
      sql,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_name_key_idx' OR name LIKE '%_identity_key_idx'",
    );
    expect(indexes.map((index) => index.name).toSorted()).toEqual([
      "guardian_relationships_active_guardian_name_key_idx",
      "memberships_active_child_identity_key_idx",
    ]);
  });

  it("fails with a coded error naming the conflict counts and changes nothing", async () => {
    const sql = await seededBeforeNameKeys();
    const [averyRow] = await rows<{ birth_date: string }>(
      sql,
      "SELECT birth_date FROM participants WHERE id = ?",
      [avery.participantId],
    );
    await insertChild(
      sql,
      {
        id: "avery_again",
        displayName: "  avery   SCENARIO ",
        birthDate: averyRow?.birth_date ?? "",
      },
      false,
    );
    await insertPlaceholderGuardian(sql, {
      id: "morgan_again",
      displayName: "MORGAN placeholder",
      participantId: casey.participantId,
      relationship: "guardian",
    });

    const failure = await migrateAll(sql).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RosterNameKeyConflictError);
    expect(failure).toMatchObject({
      code: ROSTER_NAME_KEY_CONFLICT,
      guardianConflicts: 1,
      childConflicts: 1,
      guardianRelationshipIds: [
        ["guardian_relationship_morgan_again", "guardian_relationship_seed_placeholder_casey"],
      ],
      membershipIds: [["membership_avery_again", "membership_seed_falcons_avery"]],
    });
    const message = (failure as Error).message;
    expect(message).toContain(ROSTER_NAME_KEY_CONFLICT);
    expect(message).toContain("membership_avery_again");
    expect(message).toContain("guardian_relationship_morgan_again");
    expect(message.toLowerCase()).not.toContain("scenario");
    expect(message.toLowerCase()).not.toContain("morgan placeholder");
    expect(
      await rows(sql, "SELECT version FROM schema_migrations WHERE version = ?", [
        addRosterNameKeys.version,
      ]),
    ).toEqual([]);
    expect(await columnNames(sql, "memberships")).not.toContain("child_identity_key");
    expect(await columnNames(sql, "guardian_relationships")).not.toContain("guardian_name_key");
    expect(
      await rows(sql, "SELECT id FROM memberships WHERE id = 'membership_avery_again'"),
    ).toEqual([{ id: "membership_avery_again" }]);
  });

  it("ignores duplicates on rows that are not active", async () => {
    const sql = await seededBeforeNameKeys();
    const [averyRow] = await rows<{ birth_date: string }>(
      sql,
      "SELECT birth_date FROM participants WHERE id = ?",
      [avery.participantId],
    );
    await insertChild(
      sql,
      {
        id: "avery_ended",
        displayName: "Avery Scenario",
        birthDate: averyRow?.birth_date ?? "",
        status: "revoked",
      },
      false,
    );

    expect(await migrateAll(sql)).toEqual([addRosterNameKeys.version]);
  });
});

describe("the roster name key indexes", () => {
  async function migratedWithSeed(): Promise<SqlDatabase> {
    const sql = await seededBeforeNameKeys();
    await migrateAll(sql);
    return sql;
  }

  it("refuse a second active child with the same key in one season, inserted directly", async () => {
    const sql = await migratedWithSeed();
    const [averyRow] = await rows<{ key: string }>(
      sql,
      "SELECT child_identity_key AS key FROM memberships WHERE member_participant_id = ?",
      [avery.participantId],
    );
    const key = averyRow?.key ?? "";

    const failure = await insertChild(
      sql,
      { id: "copy", displayName: "Someone Else", birthDate: null, key },
      true,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isRosterNameKeyConflict(failure)).toBe(true);
    await insertChild(
      sql,
      { id: "ended_copy", displayName: "Ended Copy", birthDate: null, key, status: "revoked" },
      true,
    );
    await insertChild(
      sql,
      {
        id: "other_season",
        displayName: "Other Season",
        birthDate: null,
        key,
        teamId: SEED_TEAMS.second.teamId,
        seasonId: SEED_TEAMS.second.seasonId,
      },
      true,
    );
  });

  it("refuse a second active placeholder with the same name and relationship, inserted directly", async () => {
    const sql = await migratedWithSeed();
    const copy = {
      id: "copy",
      displayName: "Not Morgan",
      participantId: casey.participantId,
      relationship: "guardian",
    };

    const morganKey = await storedGuardianNameKey("Morgan Placeholder");
    const failure = await insertPlaceholderGuardian(sql, copy, morganKey).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isRosterNameKeyConflict(failure)).toBe(true);
    await insertPlaceholderGuardian(
      sql,
      { ...copy, id: "other_relationship", relationship: "caregiver" },
      morganKey,
    );
    await insertPlaceholderGuardian(sql, { ...copy, id: "account_bound" }, null);
  });

  it("refuse a participant membership with no key, but not an adult one", async () => {
    const sql = await migratedWithSeed();

    const failure = await insertChild(
      sql,
      { id: "keyless", displayName: "Keyless Kid", birthDate: null },
      false,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("memberships_participant_child_key_check");
    expect(isRosterNameKeyConflict(failure)).toBe(false);
    await sql
      .prepare(
        "INSERT INTO memberships (id, team_id, season_id, member_kind, member_person_id, status, created_at, updated_at) VALUES ('membership_adult_keyless', ?, ?, 'person', 'person_seed_parent', 'active', ?, ?)",
      )
      .run([falconsTeam, falconsSeason, NOW, NOW]);
  });

  it("does not take an unrelated UNIQUE violation for a name key conflict", async () => {
    const sql = await migratedWithSeed();
    const failure = await sql
      .prepare(
        "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, 'x', 'active', ?, ?)",
      )
      .run(["person_seed_parent", NOW, NOW])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect(isRosterNameKeyConflict(failure)).toBe(false);
  });
});

/**
 * A Db whose next transactions run `before[n]` first, outside the transaction.
 * It stands in for a concurrent writer: what it commits is invisible to the
 * route's JS check on the first attempt only when the test makes it so.
 */
function scriptedDb(db: Db, sql: SqlDatabase) {
  const before: (string | undefined)[] = [];
  const transaction = async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
    const statement = before.shift();
    if (statement !== undefined) await sql.exec(statement);
    return db.transaction(run);
  };
  const proxied = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") return transaction;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { db: proxied, before };
}

async function rosterApp() {
  const sql = await openDatabase();
  const { db: realDb, sessions } = await identityServices(sql, { mode: "development" });
  const scripted = scriptedDb(realDb, sql);
  const { config } = createApplication({
    sql,
    db: scripted.db,
    sessions,
    clock: Date.now,
    mode: "development",
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
    invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
  });
  const app = await createApp(config);
  const signedIn = await app.handle("POST", "/api/dev/sign-in", { headers: sameOrigin });
  const setCookie = Object.entries(signedIn.headers).find(
    ([name]) => name.toLowerCase() === "set-cookie",
  )?.[1];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";", 1)[0] ?? "";
  const post = (path: string, body: unknown) =>
    app.handle("POST", path, { headers: { ...sameOrigin, cookie }, body });

  const team = await post("/api/teams", { name: "Key Testers" });
  const teamId = (JSON.parse(String(team.body)) as { team: { id: string } }).team.id;
  const season = await post(`/api/teams/${teamId}/seasons`, {
    label: "Spring",
    startDate: "2026-03-01",
    endDate: "2026-06-01",
    timeZone: "America/Phoenix",
  });
  const seasonId = (JSON.parse(String(season.body)) as { season: { id: string } }).season.id;
  const seasonPath = `/api/teams/${teamId}/seasons/${seasonId}`;

  return { sql, post, seasonPath, before: scripted.before };
}

function body(response: { body: unknown }): unknown {
  return JSON.parse(String(response.body));
}

const riley = { displayName: "Riley Race", birthDate: "2018-01-01" };

async function addRiley(context: Awaited<ReturnType<typeof rosterApp>>) {
  const added = await context.post(`${context.seasonPath}/participants`, riley);
  expect(added.status).toBe(201);
  return (body(added) as { participant: { participantId: string } }).participant.participantId;
}

describe("roster writes keep the stored keys", () => {
  it("writes the child key on add and answers 409 for the same child again", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);

    expect(
      await rows(
        context.sql,
        "SELECT child_identity_key AS key FROM memberships WHERE member_participant_id = ?",
        [participantId],
      ),
    ).toEqual([{ key: await storedChildIdentityKey(riley) }]);

    const again = await context.post(`${context.seasonPath}/participants`, {
      displayName: " riley  RACE ",
      birthDate: riley.birthDate,
    });
    expect(again.status).toBe(409);
    expect(body(again)).toEqual({ error: "participant already rostered" });

    const noBirthDate = await context.post(`${context.seasonPath}/participants`, {
      displayName: riley.displayName,
    });
    expect(noBirthDate.status).toBe(201);
  });

  it("writes the placeholder guardian key on attach and on import", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);
    expect(
      (
        await context.post(`/api/participants/${participantId}/guardians`, {
          displayName: "  Alex   GUARDIAN ",
          relationship: "parent",
        })
      ).status,
    ).toBe(201);
    const imported = await context.post(`${context.seasonPath}/roster/import`, {
      rows: [
        {
          displayName: "Imported Kid",
          guardians: [{ displayName: "Bo Guardian", relationship: "guardian" }],
        },
      ],
    });
    expect(imported.status).toBe(201);

    expect(
      await rows(
        context.sql,
        "SELECT guardian_name_key AS key, relationship FROM guardian_relationships ORDER BY key",
      ),
    ).toEqual(
      [
        { key: await storedGuardianNameKey("Alex Guardian"), relationship: "parent" },
        { key: await storedGuardianNameKey("Bo Guardian"), relationship: "guardian" },
      ].toSorted((left, right) => left.key.localeCompare(right.key)),
    );
    expect(
      await rows(
        context.sql,
        "SELECT child_identity_key AS key FROM memberships WHERE member_kind = 'participant' ORDER BY key",
      ),
    ).toEqual(
      [
        { key: await storedChildIdentityKey(riley) },
        { key: await storedChildIdentityKey({ displayName: "Imported Kid" }) },
      ].toSorted((left, right) => left.key.localeCompare(right.key)),
    );
  });

  it("stores a 64-character hex digest, never the name, for any name length", async () => {
    const context = await rosterApp();
    const longName = `Long ${"Name".repeat(3_000)}`;
    const added = await context.post(`${context.seasonPath}/participants`, {
      displayName: longName,
      birthDate: riley.birthDate,
    });
    expect(added.status).toBe(201);
    const { participantId } = (body(added) as { participant: { participantId: string } })
      .participant;
    expect(
      (
        await context.post(`/api/participants/${participantId}/guardians`, {
          displayName: "Alex Guardian",
          relationship: "parent",
        })
      ).status,
    ).toBe(201);

    const keys = await rows<{ key: string }>(
      context.sql,
      "SELECT child_identity_key AS key FROM memberships WHERE member_kind = 'participant' UNION ALL SELECT guardian_name_key AS key FROM guardian_relationships",
    );
    expect(keys).toHaveLength(2);
    for (const { key } of keys) {
      expect(key).toMatch(SHA256_HEX);
      expect(key).not.toContain("name");
      expect(key).not.toContain("alex");
      expect(key).not.toContain(riley.birthDate);
    }
  });
});

describe("the import backstop", () => {
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });

  it("runs an import again after a Postgres deadlock abort", async () => {
    let attempts = 0;
    const outcome = await withRosterNameKeyBackstop(
      () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(deadlock) : Promise.resolve("committed");
      },
      { retries: 1, conflict: "conflict", deadlocks: true },
    );

    expect(outcome).toBe("committed");
    expect(attempts).toBe(2);
  });

  it("answers the conflict value when the deadlock repeats", async () => {
    await expect(
      withRosterNameKeyBackstop(() => Promise.reject(new Error("wrapped", { cause: deadlock })), {
        retries: 1,
        conflict: "conflict",
        deadlocks: true,
      }),
    ).resolves.toBe("conflict");
  });

  it("rethrows a deadlock where the caller did not ask for it", async () => {
    await expect(
      withRosterNameKeyBackstop(() => Promise.reject(deadlock), {
        retries: 0,
        conflict: "duplicate",
      }),
    ).rejects.toBe(deadlock);
  });
});

describe("a write the JS check misses still meets the index", () => {
  it("answers the add-child 409 when a stale key holds the slot", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);
    await context.sql
      .prepare(
        "UPDATE people SET display_name = 'Renamed Without Key' WHERE id = (SELECT person_id FROM participants WHERE id = ?)",
      )
      .run([participantId]);

    const again = await context.post(`${context.seasonPath}/participants`, riley);

    expect(again.status).toBe(409);
    expect(body(again)).toEqual({ error: "participant already rostered" });
    expect(
      await rows(context.sql, "SELECT id FROM memberships WHERE member_kind = 'participant'"),
    ).toHaveLength(1);
  });

  it("answers the attach 409 when a stale key holds the slot", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);
    const guardian = { displayName: "Alex Guardian", relationship: "parent" };
    expect(
      (await context.post(`/api/participants/${participantId}/guardians`, guardian)).status,
    ).toBe(201);
    await context.sql
      .prepare(
        "UPDATE people SET display_name = 'Renamed Without Key' WHERE id = (SELECT guardian_person_id FROM guardian_relationships WHERE participant_id = ?)",
      )
      .run([participantId]);

    const again = await context.post(`/api/participants/${participantId}/guardians`, guardian);

    expect(again.status).toBe(409);
    expect(body(again)).toEqual({ error: "guardian already attached" });
    expect(
      await rows(context.sql, "SELECT id FROM guardian_relationships WHERE participant_id = ?", [
        participantId,
      ]),
    ).toHaveLength(1);
  });

  it("gives an import that lost a race the duplicate_in_roster verdict", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);
    context.before.push(
      `UPDATE participants SET status = 'hidden_from_check' WHERE id = '${participantId}'`,
      `UPDATE participants SET status = 'active' WHERE id = '${participantId}'`,
    );

    const imported = await context.post(`${context.seasonPath}/roster/import`, {
      rows: [{ ...riley, guardians: [] }],
    });

    expect(imported.status).toBe(200);
    expect(body(imported)).toEqual({
      summary: { requested: 1, created: 0, skipped: 1 },
      rows: [{ index: 0, outcome: "duplicate_in_roster" }],
    });
    expect(context.before).toEqual([]);
    expect(
      await rows(context.sql, "SELECT id FROM memberships WHERE member_kind = 'participant'"),
    ).toHaveLength(1);
  });

  it("answers a coded 409 when the import still conflicts after its retry", async () => {
    const context = await rosterApp();
    const participantId = await addRiley(context);
    await context.sql
      .prepare("UPDATE participants SET status = 'hidden_from_check' WHERE id = ?")
      .run([participantId]);

    const imported = await context.post(`${context.seasonPath}/roster/import`, {
      rows: [{ ...riley, guardians: [] }],
    });

    expect(imported.status).toBe(409);
    expect(body(imported)).toMatchObject({ code: "roster_changed" });
    expect(
      await rows(context.sql, "SELECT id FROM memberships WHERE member_kind = 'participant'"),
    ).toHaveLength(1);
  });
});
