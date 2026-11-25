import { afterAll, describe, expect, it } from "vitest";
import { rawChanges } from "@lesto/db";
import { Schema } from "@lesto/migrate";
import { z } from "zod";
import {
  abortUnless,
  EvidenceChangedError,
  isBatchGuardAbort,
  proofGuard,
  runGuardedBatch,
} from "../app/lib/server/authorization";
import { applicationMigrations } from "../app/lib/server/composition";
import { errorChain } from "../app/lib/server/error-chain";
import { accounts, people, VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
import { createOrganizations, SNACKDAY_ORGANIZATION_ID } from "../app/lib/server/organizations";
import { createCoordinationOperations } from "../app/lib/server/coordination-operations";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import type { InviteDelivery, InviteDeliverer } from "../app/lib/server/invite-delivery";
import { openRuntimeApplication, runtimeConfiguration } from "../runtime";
import type { RuntimeApplication } from "../runtime";

const databaseUrl = process.env["SNACKDAY_TEST_POSTGRES_URL"];
const opened: RuntimeApplication[] = [];
const deliveries: InviteDelivery[] = [];
const delivery: InviteDeliverer = {
  deliver(payload) {
    deliveries.push(payload);
    return Promise.resolve();
  },
  currentLink: () => undefined,
};
const clock = () => Date.parse("2029-01-10T12:00:00.000Z");
const POSTGRES_NOT_NULL_VIOLATION = "23502";
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const POSTGRES_CHECK_VIOLATION = "23514";

/** The SQLSTATE a refused statement failed with, or undefined when it ran. */
function errorCode(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) =>
      errorChain(error)
        .map((link) => (link as { code?: unknown } | null)?.code)
        .find((code) => typeof code === "string"),
  );
}

async function boot() {
  if (!databaseUrl) throw new Error("Run bash scripts/runtime/postgres-integration.sh");
  const runtime = await openRuntimeApplication(
    runtimeConfiguration({
      SNACKDAY_RUNTIME_MODE: "staging",
      SNACKDAY_DATABASE_DIALECT: "postgres",
      DATABASE_URL: databaseUrl,
      SNACKDAY_DATABASE_POOL_MAX: "4",
      SNACKDAY_PUBLIC_BASE_URL: "https://staging.snackduty.test",
      SNACKDAY_APPLE_CLIENT_ID: "com.snackday.postgres-fixture",
    }),
    {
      clock,
      inviteDelivery: delivery,
      invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
    },
  );
  opened.push(runtime);
  return runtime;
}

afterAll(async () => {
  for (const runtime of opened) await runtime.close();
});

async function adult(runtime: RuntimeApplication, id: string) {
  const now = new Date(clock()).toISOString();
  await runtime.db
    .insert(people)
    .values({
      id: `person_${id}`,
      displayName: `Synthetic ${id}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await runtime.db
    .insert(accounts)
    .values({
      id: `account_${id}`,
      personId: `person_${id}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const session = await runtime.sessions.create(`account_${id}`, 600_000);
  return `${VERIFIED_SESSION_COOKIE}=${session.token}`;
}

const headers = (cookie: string) => ({ cookie, "sec-fetch-site": "same-origin" });
const entity = z.object({ id: z.string() });

// Queue requests behind an actual PostgreSQL row lock and verify they really
// reached the database before releasing it. No timing-based race assumption.
async function race<T>(
  runtime: RuntimeApplication,
  teamId: string,
  requests: readonly (() => Promise<T>)[],
  lockStatement: string = "UPDATE teams SET id = id WHERE id = ?",
): Promise<T[]> {
  let release = () => {};
  let locked = () => {};
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = runtime.sql.transaction(async (sql) => {
    await sql.prepare(lockStatement).run(lockStatement.includes("?") ? [teamId] : []);
    locked();
    await gate;
  });
  await ready;
  const pending: Promise<T>[] = [];
  try {
    for (const request of requests) {
      pending.push(request());
      const deadline = Date.now() + 5000;
      while (true) {
        const waiting = z
          .object({ count: z.number() })
          .parse(
            await runtime.sql
              .prepare(
                "SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
              )
              .get(),
          );
        if (waiting.count >= pending.length) break;
        if (Date.now() >= deadline)
          throw new Error("Concurrent request never reached the database lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    release();
    await blocker;
  }
  return Promise.all(pending);
}

describe.skipIf(!databaseUrl)("real TLS PostgreSQL runtime", () => {
  it("migrates, persists sessions across pools, rolls back acceptance, and serializes concurrent retries", async () => {
    const first = await boot();
    expect(first.migrationsApplied).toEqual(
      applicationMigrations.map((migration) => migration.version),
    );
    expect(
      await first.sql.prepare("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").get(),
    ).toEqual({ ssl: true });
    const owner = await adult(first, "owner");
    const recipient = await adult(first, "recipient");
    const stranger = await adult(first, "stranger");
    const created = await first.app.handle("POST", "/api/teams", {
      headers: headers(owner),
      body: { name: "Postgres Falcons" },
    });
    expect(created.status).toBe(201);
    const { team } = z.object({ team: entity }).parse(JSON.parse(created.body));
    await first.close();

    const runtime = await boot();
    const peer = await boot();
    expect(runtime.migrationsApplied).toEqual([]);
    expect(peer.migrationsApplied).toEqual([]);
    const session = await peer.app.handle("GET", "/api/session", { headers: headers(owner) });
    expect(session.status).toBe(200);
    expect(session.body).toContain("account_owner");
    expect(
      (await peer.app.handle("GET", `/api/teams/${team.id}`, { headers: headers(stranger) }))
        .status,
    ).toBe(404);

    const invited = await runtime.app.handle("POST", `/api/teams/${team.id}/invitations`, {
      headers: headers(owner),
      body: {
        invitedRole: "adult",
        inviteeLabel: "Synthetic recipient",
        recipientBinding: { kind: "confirmed_person", personId: "person_recipient" },
      },
    });
    expect(invited.status).toBe(201);
    const { invitation } = z.object({ invitation: entity }).parse(JSON.parse(invited.body));
    expect(deliveries).toHaveLength(0);
    expect(await runtime.outbox?.drain()).toBe(1);
    expect(deliveries).toHaveLength(1);
    const token = deliveries[0]?.inviteUrl.slice("/invite#".length);
    expect(token).toBeTruthy();
    const accept = (app: RuntimeApplication, cookie: string) =>
      app.app.handle("POST", "/api/invitations/accept", {
        headers: headers(cookie),
        body: { token },
      });
    expect((await accept(peer, stranger)).status).toBe(404);

    // Force a database error AFTER the token claim. The entire transaction must
    // roll back, leaving the invitation retryable and granting no membership.
    await runtime.sql.exec(
      "CREATE FUNCTION reject_test_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic membership failure'; END $$",
    );
    await runtime.sql.exec(
      "CREATE TRIGGER reject_test_membership BEFORE INSERT ON adult_memberships FOR EACH ROW EXECUTE FUNCTION reject_test_membership()",
    );
    try {
      await expect(accept(runtime, recipient)).rejects.toMatchObject({ code: "P0001" });
      expect(
        await runtime.sql
          .prepare("SELECT status, accepted_by_person_id FROM invitations WHERE id = ?")
          .get([invitation.id]),
      ).toEqual({ status: "pending", accepted_by_person_id: null });
      expect(
        await runtime.sql
          .prepare("SELECT id FROM adult_memberships WHERE team_id = ? AND person_id = ?")
          .all([team.id, "person_recipient"]),
      ).toEqual([]);
    } finally {
      await runtime.sql.exec("DROP TRIGGER reject_test_membership ON adult_memberships");
      await runtime.sql.exec("DROP FUNCTION reject_test_membership()");
    }

    const accepted = await race(runtime, team.id, [
      () => accept(runtime, recipient),
      () => accept(peer, recipient),
    ]);
    expect(accepted.map((response) => response.status)).toEqual([200, 200]);
    expect(accepted[0]?.body).toBe(accepted[1]?.body);
    expect(
      await runtime.sql
        .prepare("SELECT status, accepted_by_person_id FROM invitations WHERE id = ?")
        .get([invitation.id]),
    ).toEqual({ status: "accepted", accepted_by_person_id: "person_recipient" });
    expect(
      await runtime.sql
        .prepare("SELECT person_id FROM adult_memberships WHERE team_id = ? AND person_id = ?")
        .all([team.id, "person_recipient"]),
    ).toEqual([{ person_id: "person_recipient" }]);

    const invite = (app: RuntimeApplication, label: string) =>
      app.app.handle("POST", `/api/teams/${team.id}/invitations`, {
        headers: headers(owner),
        body: {
          invitedRole: "adult",
          inviteeLabel: label,
          recipientBinding: { kind: "confirmed_person", personId: "person_recipient" },
        },
      });
    const duplicate = await race(runtime, team.id, [
      () => invite(runtime, "Duplicate"),
      () => invite(peer, "Duplicate"),
    ]);
    expect(duplicate.map((response) => response.status)).toEqual([201, 409]);

    for (const action of ["revoke", "resend"] as const) {
      for (const acceptFirst of [true, false]) {
        const response = await invite(runtime, `${action}-${acceptFirst}`);
        expect(response.status).toBe(201);
        const row = z.object({ invitation: entity }).parse(JSON.parse(response.body)).invitation;
        await runtime.outbox?.drain();
        const link = deliveries.find((payload) => payload.invitationId === row.id)?.inviteUrl;
        expect(link).toBeTruthy();
        const accepting = () =>
          runtime.app.handle("POST", "/api/invitations/accept", {
            headers: headers(recipient),
            body: { token: link?.slice("/invite#".length) },
          });
        const changing = () =>
          peer.app.handle("POST", `/api/teams/${team.id}/invitations/${row.id}/${action}`, {
            headers: headers(owner),
          });
        const results = await race(
          runtime,
          team.id,
          acceptFirst ? [accepting, changing] : [changing, accepting],
        );
        expect(results.map((result) => result.status)).toEqual(
          acceptFirst ? [200, 409] : [200, 404],
        );
        expect(
          await runtime.sql.prepare("SELECT status FROM invitations WHERE id = ?").get([row.id]),
        ).toEqual({
          status: acceptFirst ? "accepted" : action === "revoke" ? "revoked" : "pending",
        });
      }
    }

    const seasonResponse = await runtime.app.handle("POST", `/api/teams/${team.id}/seasons`, {
      headers: headers(owner),
      body: {
        label: "Spring 2029",
        startDate: "2029-01-01",
        endDate: "2029-06-01",
        timeZone: "UTC",
      },
    });
    expect(seasonResponse.status).toBe(201);
    const { season } = z.object({ season: entity }).parse(JSON.parse(seasonResponse.body));
    const actor = { accountId: "account_owner", personId: "person_owner" };
    const input = {
      teamId: team.id,
      seasonId: season.id,
      input: {
        title: "Saturday game",
        kind: "game" as const,
        schedule: {
          timeZone: "UTC",
          localTime: "12:00",
          durationMinutes: 60,
          frequency: "once" as const,
          startDate: "2029-02-03",
        },
        requestId: "6f0f8629-8cdb-4d1e-85c4-f87bd493a6f8",
        snackDuty: { label: "Bring fruit", instructions: "Synthetic fixture" },
      },
    };
    const events = await race(
      runtime,
      team.id,
      [runtime, peer].map(
        (app) => () =>
          createCoordinationOperations({ db: app.db, clock }).createEvent(actor, input),
      ),
    );
    expect(events[0]?.ok).toBe(true);
    expect(events[1]).toEqual(events[0]);
    for (const table of [
      "event_series",
      "event_occurrences",
      "duty_slots",
      "event_creation_receipts",
    ]) {
      // Fixed test-owned identifiers only; pg COUNT is int8 (a string).
      expect(
        await runtime.sql.prepare(`SELECT COUNT(*)::integer AS count FROM ${table}`).get(),
      ).toEqual({ count: 1 });
    }
  }, 30_000);

  it("answers a roster name key race with the same 409 or verdict as a sequential write", async () => {
    const runtime = await boot();
    const peer = await boot();
    const owner = await adult(runtime, "key_owner");
    const created = await runtime.app.handle("POST", "/api/teams", {
      headers: headers(owner),
      body: { name: "Postgres Keys" },
    });
    const { team } = z.object({ team: entity }).parse(JSON.parse(created.body));
    const seasonResponse = await runtime.app.handle("POST", `/api/teams/${team.id}/seasons`, {
      headers: headers(owner),
      body: { label: "Keys", startDate: "2029-01-01", endDate: "2029-06-01", timeZone: "UTC" },
    });
    const { season } = z.object({ season: entity }).parse(JSON.parse(seasonResponse.body));
    const seasonPath = `/api/teams/${team.id}/seasons/${season.id}`;
    const post = (app: RuntimeApplication, path: string, body: unknown) =>
      app.app.handle("POST", path, { headers: headers(owner), body });
    // Reads pass the lock; every insert waits behind it, after its JS check.
    const lockMemberships = "LOCK TABLE memberships IN EXCLUSIVE MODE";
    const lockGuardians = "LOCK TABLE guardian_relationships IN EXCLUSIVE MODE";
    const statuses = (responses: readonly { status: number }[]) =>
      responses.map((response) => response.status).toSorted();

    const child = { displayName: "Race Kid", birthDate: "2021-02-03" };
    const added = await race(
      runtime,
      team.id,
      [runtime, peer].map((app) => () => post(app, `${seasonPath}/participants`, child)),
      lockMemberships,
    );
    expect(statuses(added)).toEqual([201, 409]);
    expect(added.map((response) => response.body)).toContainEqual(
      JSON.stringify({ error: "participant already rostered" }),
    );
    const winner = added.find((response) => response.status === 201);
    const { participant } = z
      .object({ participant: z.object({ participantId: z.string() }) })
      .parse(JSON.parse(winner?.body ?? "{}"));

    const guardian = { displayName: "Race Guardian", relationship: "parent" };
    const attached = await race(
      runtime,
      team.id,
      [runtime, peer].map(
        (app) => () =>
          post(app, `/api/participants/${participant.participantId}/guardians`, guardian),
      ),
      lockGuardians,
    );
    expect(statuses(attached)).toEqual([201, 409]);
    expect(attached.map((response) => response.body)).toContainEqual(
      JSON.stringify({ error: "guardian already attached" }),
    );

    const imported = await race(
      runtime,
      team.id,
      [runtime, peer].map(
        (app) => () =>
          post(app, `${seasonPath}/roster/import`, {
            rows: [{ displayName: "Imported Race Kid", guardians: [] }],
          }),
      ),
      lockMemberships,
    );
    expect(statuses(imported)).toEqual([200, 201]);
    expect(imported.find((response) => response.status === 200)?.body).toContain(
      "duplicate_in_roster",
    );
    expect(
      await runtime.sql
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM memberships WHERE season_id = ? AND member_kind = 'participant'",
        )
        .get([season.id]),
    ).toEqual({ count: 2 });

    // Opposite row order: each import inserts its first child, then waits on
    // the other's uncommitted key, so Postgres may abort one with a deadlock.
    const first = { displayName: "Order Kid A", guardians: [] };
    const second = { displayName: "Order Kid B", guardians: [] };
    const crossed = await race(
      runtime,
      team.id,
      [
        () => post(runtime, `${seasonPath}/roster/import`, { rows: [first, second] }),
        () => post(peer, `${seasonPath}/roster/import`, { rows: [second, first] }),
      ],
      lockMemberships,
    );
    expect(statuses(crossed)).toEqual([200, 201]);
    expect(crossed.find((response) => response.status === 200)?.body).toContain('"created":0');

    // Random text does not compress, so the plain key would pass the B-tree row limit.
    const longName = Array.from({ length: 340 }, () => crypto.randomUUID()).join(" ");
    expect(
      (await post(runtime, `${seasonPath}/participants`, { displayName: longName })).status,
    ).toBe(201);
    const keys = await runtime.sql
      .prepare(
        "SELECT child_identity_key AS key FROM memberships WHERE season_id = ? AND member_kind = 'participant'",
      )
      .all([season.id]);
    expect(keys).toHaveLength(5);
    for (const row of z.array(z.object({ key: z.string() })).parse(keys)) {
      expect(row.key).toMatch(/^[0-9a-f]{64}$/u);
    }
    await expect(
      runtime.sql
        .prepare(
          "INSERT INTO memberships (id, team_id, season_id, member_kind, member_participant_id, status, created_at, updated_at) SELECT 'membership_keyless', team_id, season_id, 'participant', member_participant_id, 'revoked', created_at, updated_at FROM memberships WHERE season_id = ? LIMIT 1",
        )
        .run([season.id]),
    ).rejects.toMatchObject({ code: "23514" });

    expect(
      await runtime.sql
        .prepare(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('memberships_active_child_identity_key_idx', 'guardian_relationships_active_guardian_name_key_idx') ORDER BY indexname",
        )
        .all(),
    ).toEqual([
      { indexname: "guardian_relationships_active_guardian_name_key_idx" },
      { indexname: "memberships_active_child_identity_key_idx" },
    ]);
  }, 30_000);

  it("rolls back a whole batch when its abortUnless guard fails, and maps it to EvidenceChangedError", async () => {
    const runtime = await boot();
    await adult(runtime, "batch_guard");
    const now = new Date(clock()).toISOString();
    const personExists = (id: string) =>
      proofGuard([{ sql: "EXISTS (SELECT 1 FROM people WHERE people.id = ?)", params: [id] }]);
    const insertPerson = (id: string) =>
      rawChanges(
        "INSERT INTO people (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [id, "Synthetic batch guard", "active", now, now],
      );
    const peopleNamed = async (id: string) =>
      z
        .object({ count: z.number() })
        .parse(
          await runtime.sql
            .prepare("SELECT COUNT(*)::integer AS count FROM people WHERE id = ?")
            .get([id]),
        ).count;

    await runtime.db.batch([
      abortUnless(personExists("person_batch_guard")),
      insertPerson("person_batch_guard_lands"),
    ]);
    expect(await peopleNamed("person_batch_guard_lands")).toBe(1);

    const aborted = await runtime.db
      .batch([
        insertPerson("person_batch_guard_before"),
        abortUnless(personExists("person_batch_guard_absent")),
        insertPerson("person_batch_guard_after"),
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isBatchGuardAbort(aborted)).toBe(true);
    expect(await peopleNamed("person_batch_guard_before")).toBe(0);
    expect(await peopleNamed("person_batch_guard_after")).toBe(0);

    await expect(
      runGuardedBatch(runtime.db, personExists("person_batch_guard_absent"), [
        insertPerson("person_batch_guard_refused"),
      ]),
    ).rejects.toBeInstanceOf(EvidenceChangedError);
    expect(await peopleNamed("person_batch_guard_refused")).toBe(0);

    await expect(
      runGuardedBatch(runtime.db, proofGuard([{ sql: "CAST(NULL AS BOOLEAN)", params: [] }]), [
        insertPerson("person_batch_guard_null"),
      ]),
    ).rejects.toBeInstanceOf(EvidenceChangedError);
    expect(await peopleNamed("person_batch_guard_null")).toBe(0);

    await runtime.db.batch([insertPerson("person_batch_guard_doomed")]);
    await expect(
      runGuardedBatch(runtime.db, personExists("person_batch_guard_doomed"), [
        rawChanges("DELETE FROM people WHERE id = ?", ["person_batch_guard_doomed"]),
      ]),
    ).rejects.toBeInstanceOf(EvidenceChangedError);
    expect(await peopleNamed("person_batch_guard_doomed")).toBe(1);
    expect(
      await runtime.sql.prepare("SELECT COUNT(*)::integer AS count FROM batch_guard").get(),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("puts every team in an organization, seeds the three organizations and enforces the constraints", async () => {
    const runtime = await boot();
    const owner = await adult(runtime, "organization_owner");
    const now = new Date(clock()).toISOString();
    const insertTeam = (id: string, organizationId: string | null) =>
      runtime.sql
        .prepare(
          "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at, organization_id) VALUES (?, 'Synthetic team', 'active', 'person_organization_owner', ?, ?, ?)",
        )
        .run([id, now, now, organizationId]);
    const organizationOf = async (teamId: string) =>
      runtime.sql.prepare("SELECT organization_id FROM teams WHERE id = ?").get([teamId]);

    const created = await runtime.app.handle("POST", "/api/teams", {
      headers: headers(owner),
      body: { name: "Postgres Org Falcons" },
    });
    expect(created.status).toBe(201);
    const { team } = z.object({ team: entity }).parse(JSON.parse(created.body));
    expect(JSON.parse(created.body)).not.toHaveProperty("team.organizationId");
    expect(await organizationOf(team.id)).toEqual({ organization_id: SNACKDAY_ORGANIZATION_ID });

    expect(
      await runtime.sql
        .prepare(
          "SELECT organization_id, hostname FROM organization_hostnames WHERE is_primary = 1 ORDER BY organization_id",
        )
        .all(),
    ).toEqual([
      { organization_id: "org_ballplayer", hostname: "ballplayer.co" },
      { organization_id: "org_coach", hostname: "dimasciobaseball.com" },
      { organization_id: SNACKDAY_ORGANIZATION_ID, hostname: "snackday.app" },
    ]);

    expect(await errorCode(insertTeam("team_pg_no_org", null))).toBe(POSTGRES_NOT_NULL_VIOLATION);
    expect(await errorCode(insertTeam("team_pg_unknown_org", "org_missing"))).toBe(
      POSTGRES_FOREIGN_KEY_VIOLATION,
    );
    expect(
      await errorCode(
        runtime.sql
          .prepare(
            "INSERT INTO organizations (id, slug, name, kind, theme, created_at, updated_at) VALUES ('org_pg_bad', 'pg-bad', 'Bad', 'school', 'snackday', ?, ?)",
          )
          .run([now, now]),
      ),
    ).toBe(POSTGRES_CHECK_VIOLATION);
    expect(
      await errorCode(
        runtime.sql
          .prepare(
            "INSERT INTO organization_modules (organization_id, module) VALUES (?, 'payments')",
          )
          .run([SNACKDAY_ORGANIZATION_ID]),
      ),
    ).toBe(POSTGRES_CHECK_VIOLATION);
    expect(
      await errorCode(
        runtime.sql
          .prepare(
            "INSERT INTO organization_hostnames (hostname, organization_id, kind, status, is_primary, created_at, updated_at) VALUES ('pg.snackday.app', ?, 'subdomain', 'active', 1, ?, ?)",
          )
          .run([SNACKDAY_ORGANIZATION_ID, now, now]),
      ),
    ).toBe(POSTGRES_UNIQUE_VIOLATION);

    const schema = new Schema(runtime.sql, "postgres");
    await createOrganizations.migration.down?.(schema);
    await runtime.sql
      .prepare(
        "INSERT INTO teams (id, name, status, created_by_person_id, created_at, updated_at) VALUES ('team_pg_before_orgs', 'Synthetic team', 'active', 'person_organization_owner', ?, ?)",
      )
      .run([now, now]);
    await createOrganizations.migration.up(schema);
    expect(await organizationOf("team_pg_before_orgs")).toEqual({
      organization_id: SNACKDAY_ORGANIZATION_ID,
    });
    expect(
      await runtime.sql
        .prepare(
          "SELECT COUNT(*)::integer AS count FROM teams WHERE organization_id IS DISTINCT FROM ?",
        )
        .get([SNACKDAY_ORGANIZATION_ID]),
    ).toEqual({ count: 0 });
    expect(await errorCode(insertTeam("team_pg_no_org_again", null))).toBe(
      POSTGRES_NOT_NULL_VIOLATION,
    );
  }, 30_000);
});
