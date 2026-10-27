import { createApp } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySeed } from "../app/dev/seed-database";
import { SEED_PERSONAS, SEED_TEAMS } from "../app/dev/seed-personas";
import type { SeedPersonaKey } from "../app/dev/seed-personas";
import { registerDevSignIn } from "../app/dev/sign-in";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";

type Handle = Awaited<ReturnType<typeof createApp>>["handle"];

const sameOrigin = { "sec-fetch-site": "same-origin" };
const { falcons, comets } = {
  falcons: SEED_TEAMS.coached.teamId,
  comets: SEED_TEAMS.second.teamId,
};

const EXPECTED_ACCESS: Record<SeedPersonaKey, Record<string, "manage" | "read">> = {
  "head-coach": { [falcons]: "manage" },
  "co-coach": { [falcons]: "manage" },
  parent: { [falcons]: "read" },
  "second-team-guardian": { [comets]: "read" },
  "team-member": { [falcons]: "read" },
  stranger: {},
  default: { [comets]: "manage" },
  "second-adult": { [falcons]: "manage", [comets]: "read" },
};

let handle: Handle;
let close: () => void;

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  close = opened.close;
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
  const app = registerDevSignIn(config.app, { enabled: true, db, sessions });
  handle = (await createApp({ ...config, app })).handle;
  await applySeed(opened.db);
});

afterAll(() => close());

async function signIn(body: unknown) {
  return handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    ...(body === undefined ? {} : { body }),
  });
}

async function bodyText(response: { body: unknown }): Promise<string> {
  return typeof response.body === "string"
    ? response.body
    : await new Response(response.body as ReadableStream).text();
}

function sessionCookie(response: { headers: Record<string, string> }): string {
  const header = response.headers["Set-Cookie"] ?? response.headers["set-cookie"] ?? "";
  return header.split(";", 1)[0] ?? "";
}

describe("development sign-in for every seeded role", () => {
  for (const persona of SEED_PERSONAS) {
    it(`signs in ${persona.key} and lists only that role's teams`, async () => {
      const response = await signIn({ persona: persona.key });
      expect(response.status).toBe(200);
      expect(JSON.parse(await bodyText(response))).toEqual({
        account: { id: persona.accountId },
        person: { id: persona.personId, displayName: persona.displayName },
      });
      const cookie = sessionCookie(response);
      expect(cookie).toMatch(/^snackday_session_dev=/u);
      const teams = await handle("GET", "/api/teams", { headers: { cookie } });
      expect(teams.status).toBe(200);
      const body = JSON.parse(await bodyText(teams)) as {
        teams: { team: { id: string }; access: string }[];
      };
      expect(Object.fromEntries(body.teams.map((entry) => [entry.team.id, entry.access]))).toEqual(
        EXPECTED_ACCESS[persona.key],
      );
      expect(persona.access).toEqual(EXPECTED_ACCESS[persona.key]);
    });
  }

  it("keeps the default sign-in with no body on the development adult", async () => {
    const response = await signIn(undefined);
    expect(response.status).toBe(200);
    expect(JSON.parse(await bodyText(response)).person.displayName).toBe("Development Adult");
  });

  it("refuses unknown personas and extra fields", async () => {
    expect((await signIn({ persona: "admin" })).status).toBe(400);
    expect((await signIn({ persona: "head-coach", extra: true })).status).toBe(400);
    expect((await signIn({ persona: ["head-coach"] })).status).toBe(400);
  });

  it("lists one sign-in button per role on the development page", async () => {
    const response = await handle("GET", "/dev/sign-in", { headers: {} });
    expect(response.status).toBe(200);
    const html = await bodyText(response);
    for (const persona of SEED_PERSONAS) {
      expect(html).toContain(`data-persona="${persona.key}"`);
      expect(html).toContain(persona.role);
    }
    expect(html).not.toMatch(/<script\b(?![^>]*(?:\ssrc=|\stype="application\/json"))[^>]*>/u);
    expect(html).not.toMatch(/\son[a-z]+=/u);
  });
});
