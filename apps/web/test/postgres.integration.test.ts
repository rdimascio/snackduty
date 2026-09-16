import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { applicationMigrations } from "../app/lib/server/composition";
import { accounts, people, VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
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
    await sql.prepare("UPDATE teams SET id = id WHERE id = ?").run([teamId]);
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
});
