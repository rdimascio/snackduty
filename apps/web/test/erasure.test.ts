import { createApp } from "@lesto/kernel";
import type { SqlDatabase } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";
import { ACCOUNT_ERASE_CONFIRMATION } from "@snackday/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { applySeed } from "../app/dev/seed-database";
import { SEED_CHILDREN, SEED_TEAMS } from "../app/dev/seed-personas";
import { registerDevSignIn } from "../app/dev/sign-in";
import { createApplication } from "../app/lib/server/composition";
import { ERASED_ADULT_DISPLAY_NAME } from "../app/lib/server/erasure";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { registerRuntimePages } from "../runtime/web-surface";

type Handle = Awaited<ReturnType<typeof createApp>>["handle"];

const sameOrigin = { "sec-fetch-site": "same-origin" };
const { avery, blake } = SEED_CHILDREN;

let handle: Handle;
let sql: SqlDatabase;

beforeEach(async () => {
  const opened = await openSqlite(":memory:");
  sql = opened.db;
  const { db, sessions } = await identityServices(opened.db, { mode: "development" });
  const { config } = createApplication({
    sql: opened.db,
    db,
    sessions,
    clock: Date.now,
    mode: "development",
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
  });
  await registerRuntimePages(config.app);
  const app = registerDevSignIn(config.app, { enabled: true, db, sessions });
  handle = (await createApp({ ...config, app })).handle;
  await applySeed(opened.db);
});

async function cookieFor(persona: string): Promise<string> {
  const response = await handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    body: { persona },
  });
  expect(response.status).toBe(200);
  const cookie = response.headers["Set-Cookie"]?.split(";")[0];
  if (cookie === undefined) throw new Error(`No session cookie for ${persona}.`);
  return cookie;
}

async function pageText(path: string, cookie?: string): Promise<string> {
  const response = await handle("GET", path, cookie === undefined ? {} : { headers: { cookie } });
  expect(response.status).toBe(200);
  return typeof response.body === "string"
    ? response.body
    : new Response(response.body as ReadableStream).text();
}

function post(path: string, cookie: string, body: unknown) {
  return handle("POST", path, { headers: { ...sameOrigin, cookie }, body });
}

/** Every row in every table, as text, to prove a value is gone from the whole database. */
async function databaseText(): Promise<string> {
  const tables = (await sql
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()) as { name: string }[];
  const dumps = await Promise.all(
    tables.map(async ({ name }) =>
      JSON.stringify(await sql.prepare(`SELECT * FROM "${name}"`).all()),
    ),
  );
  return dumps.join("\n");
}

async function childPersonId(participantId: string): Promise<string> {
  const row = (await sql
    .prepare("SELECT person_id FROM participants WHERE id = ?")
    .get([participantId])) as { person_id: string };
  return row.person_id;
}

describe("child erasure", () => {
  it("erases every row that names or describes the child and leaves siblings alone", async () => {
    const parent = await cookieFor("parent");
    const averyPerson = await childPersonId(avery.participantId);
    expect(await databaseText()).toContain(avery.participantId);

    const erased = await post(`/api/participants/${avery.participantId}/erase`, parent, {
      confirmName: avery.displayName,
    });

    expect(erased.status).toBe(200);
    const remaining = await databaseText();
    expect(remaining).not.toContain(avery.participantId);
    expect(remaining).not.toContain(averyPerson);
    expect(remaining).not.toContain("Avery");
    expect(remaining).toContain(blake.participantId);
    expect(remaining).toContain(blake.displayName);
  });

  it("deletes a coach-typed placeholder guardian once their only child is erased", async () => {
    const coach = await cookieFor("head-coach");
    const linked = await post(`/api/participants/${blake.participantId}/guardians`, coach, {
      displayName: "Grandma Placeholder",
      relationship: "guardian",
    });
    expect(linked.status).toBe(201);

    const erased = await post(
      `/api/participants/${blake.participantId}/erase`,
      await cookieFor("parent"),
      { confirmName: blake.displayName },
    );

    expect(erased.status).toBe(200);
    expect(await databaseText()).not.toContain("Grandma Placeholder");
  });

  it("requires the child's exact name and a managing guardian", async () => {
    const parent = await cookieFor("parent");
    const coach = await cookieFor("head-coach");
    const path = `/api/participants/${avery.participantId}/erase`;

    expect((await post(path, parent, { confirmName: "Blake Scenario" })).status).toBe(422);
    expect((await post(path, coach, { confirmName: avery.displayName })).status).toBe(404);
    expect((await post(path, await cookieFor("stranger"), { confirmName: "x" })).status).toBe(404);
    expect(await databaseText()).toContain(avery.participantId);
  });
});

describe("account page", () => {
  it("lists only the children this adult manages", async () => {
    const parentPage = await pageText("/app/account", await cookieFor("parent"));
    const coachPage = await pageText("/app/account", await cookieFor("head-coach"));

    expect(parentPage).toContain(avery.displayName);
    expect(parentPage).toContain(blake.displayName);
    expect(coachPage).not.toContain(avery.displayName);
    expect(coachPage).toContain('"managed":[]');
  });

  it("serves the privacy policy marked as a draft", async () => {
    expect(await pageText("/privacy")).toContain(
      "Draft. This policy has not had a legal review yet",
    );
  });
});

describe("account erasure", () => {
  const confirm = { confirm: ACCOUNT_ERASE_CONFIRMATION };

  it("refuses while the adult is a team's only owner", async () => {
    const response = await post("/api/account/erase", await cookieFor("head-coach"), confirm);

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      soleOwnerTeams: [{ id: SEED_TEAMS.coached.teamId, name: SEED_TEAMS.coached.name }],
    });
  });

  it("refuses while the adult is a child's only managing guardian", async () => {
    const response = await post("/api/account/erase", await cookieFor("parent"), confirm);

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).soleGuardianOf).toEqual(
      expect.arrayContaining([{ participantId: blake.participantId }]),
    );
  });

  it("does not count a placeholder guardian as someone who can still manage the child", async () => {
    const coach = await cookieFor("head-coach");
    await post(`/api/participants/${blake.participantId}/guardians`, coach, {
      displayName: "Grandma Placeholder",
      relationship: "guardian",
    });

    const response = await post("/api/account/erase", await cookieFor("parent"), confirm);

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).soleGuardianOf).toEqual(
      expect.arrayContaining([{ participantId: blake.participantId }]),
    );
  });

  it("scrubs the adult's email and label from every invitation addressed to them", async () => {
    const stranger = await cookieFor("stranger");
    const at = new Date().toISOString();
    await sql.exec(
      `INSERT INTO provider_identity_links (id, provider, issuer, subject, account_id, created_at, updated_at) VALUES ('provider_identity_erase_test', 'email', 'test', 'casey-parent@snackday.test', 'account_seed_stranger', '${at}', '${at}')`,
    );
    await sql.exec(
      `INSERT INTO verified_identity_emails (id, link_id, account_id, normalized_email, status, verified_at, updated_at) VALUES ('verified_email_erase_test', 'provider_identity_erase_test', 'account_seed_stranger', 'casey-parent@snackday.test', 'active', '${at}', '${at}')`,
    );

    const response = await post("/api/account/erase", stranger, confirm);

    expect(response.status).toBe(200);
    const remaining = await databaseText();
    expect(remaining).not.toContain("casey-parent@snackday.test");
    expect(remaining).not.toContain("Sid, new team adult");
    expect(remaining).not.toContain("Casey's parent");
    const pending = await sql
      .prepare(
        "SELECT COUNT(*) AS count FROM invitations WHERE id IN ('invitation_seed_stranger', 'invitation_seed_casey_parent') AND status = 'pending'",
      )
      .get();
    expect(pending).toEqual({ count: 0 });
  });

  it("tombstones the adult, ends every membership and signs every session out", async () => {
    const member = await cookieFor("team-member");
    const otherSession = await cookieFor("team-member");

    const response = await post("/api/account/erase", member, confirm);

    expect(response.status).toBe(200);
    expect(response.headers["Set-Cookie"]).toContain("Max-Age=0");
    for (const cookie of [member, otherSession]) {
      expect((await handle("GET", "/api/session", { headers: { cookie } })).status).toBe(401);
    }
    const remaining = await databaseText();
    expect(remaining).not.toContain("Max Member");
    expect(remaining).toContain(ERASED_ADULT_DISPLAY_NAME);
    const active = await sql
      .prepare(
        "SELECT COUNT(*) AS count FROM adult_memberships WHERE person_id = 'person_seed_team_member' AND status = 'active'",
      )
      .get();
    expect(active).toEqual({ count: 0 });
  });

  it("requires the typed confirmation", async () => {
    await expect(
      post("/api/account/erase", await cookieFor("team-member"), { confirm: "yes" }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
  });
});
