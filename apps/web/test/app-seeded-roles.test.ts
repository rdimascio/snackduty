import { createApp } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySeed } from "../app/dev/seed-database";
import { SEED_CHILDREN, SEED_TEAMS, SEED_TIME_ZONE } from "../app/dev/seed-personas";
import type { SeedPersonaKey } from "../app/dev/seed-personas";
import { registerDevSignIn } from "../app/dev/sign-in";
import { staticLessonCatalog } from "../app/lessons/catalog";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { ageOn, localDateIn } from "../app/roster/age";
import { registerRuntimePages } from "../runtime/web-surface";

type Handle = Awaited<ReturnType<typeof createApp>>["handle"];

const sameOrigin = { "sec-fetch-site": "same-origin" };
const NOT_FOUND_TEXT = "That page isn't on the roster";
const seedNow = new Date();

let handle: Handle;
let close: () => void;
let seededBirthDates: readonly { readonly name: string; readonly birthDate: string }[];

beforeAll(async () => {
  const opened = await openSqlite(":memory:");
  close = opened.close;
  const { db, sessions } = await identityServices(opened.db, { mode: "development" });
  const { config } = createApplication({
    sql: opened.db,
    db,
    sessions,
    clock: () => seedNow.getTime(),
    mode: "development",
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
    lessons: { enabled: true, catalog: staticLessonCatalog([]) },
  });
  await registerRuntimePages(config.app);
  const app = registerDevSignIn(config.app, { enabled: true, db, sessions });
  handle = (await createApp({ ...config, app })).handle;
  await applySeed(opened.db, { now: seedNow });
  seededBirthDates = (await opened.db
    .prepare(
      "SELECT people.display_name AS name, participants.birth_date AS birthDate FROM participants JOIN people ON people.id = participants.person_id WHERE participants.birth_date IS NOT NULL",
    )
    .all([])) as { name: string; birthDate: string }[];
});

afterAll(() => close());

async function bodyText(response: { body: unknown }): Promise<string> {
  const text =
    typeof response.body === "string"
      ? response.body
      : await new Response(response.body as ReadableStream).text();
  return text.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

async function signIn(persona: SeedPersonaKey): Promise<string> {
  const response = await handle("POST", "/api/dev/sign-in", {
    headers: sameOrigin,
    body: { persona },
  });
  expect(response.status).toBe(200);
  const header = response.headers["Set-Cookie"] ?? response.headers["set-cookie"] ?? "";
  return (Array.isArray(header) ? (header[0] ?? "") : header).split(";", 1)[0] ?? "";
}

async function page(cookie: string, path: string, query: Record<string, string> = {}) {
  const response = await handle("GET", path, { headers: { cookie }, query });
  return { status: response.status, html: await bodyText(response) };
}

function executableInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((tag) => !/\ssrc=/iu.test(tag) && !/type="application\/json"/iu.test(tag));
}

describe("the /app overview roster for coaches", () => {
  const averyName = SEED_CHILDREN.avery.displayName;

  for (const persona of ["head-coach", "co-coach"] as const) {
    it(`shows ${persona} each child's age and no birth date`, async () => {
      const { status, html } = await page(await signIn(persona), "/app");
      expect(status).toBe(200);
      expect(html).toContain(SEED_TEAMS.coached.name);

      const today = localDateIn(seedNow.getTime(), SEED_TIME_ZONE);
      const avery = seededBirthDates.find((child) => child.name === averyName);
      expect(avery).toBeDefined();
      expect(html).toContain(`Age ${ageOn(avery?.birthDate ?? "", today)}`);
      const coached = seededBirthDates.filter((child) => html.includes(child.name));
      expect(coached.map((child) => child.name)).toContain(averyName);
      for (const child of coached) {
        expect(html).toContain(`Age ${ageOn(child.birthDate, today)}`);
      }
      for (const child of seededBirthDates) expect(html).not.toContain(child.birthDate);
      expect(html).not.toContain("Born ");
      expect(html).not.toContain("birthDate");
    });
  }
});

describe("pages for a team the signed-in adult is not on", () => {
  const falcons = SEED_TEAMS.coached.teamId;

  for (const path of ["/app/roster", "/app/duties"]) {
    it(`answers the stranger a rendered 404 page for ${path}?team=${falcons}`, async () => {
      const { status, html } = await page(await signIn("stranger"), path, { team: falcons });
      expect(status).toBe(404);
      expect(html).toContain(NOT_FOUND_TEXT);
      expect(executableInlineScripts(html)).toEqual([]);
      expect(html).not.toContain("data-stck");
      expect(html).not.toContain('aria-busy="true"');
      expect(html).not.toContain(SEED_TEAMS.coached.name);
      expect(html).not.toContain(SEED_CHILDREN.avery.displayName);
    });
  }
});

describe("a Falcons player card for adults who may not read it", () => {
  const falcons = SEED_TEAMS.coached;
  const cardPath = `/app/roster/${SEED_CHILDREN.avery.participantId}`;

  it("shows the head coach Avery's card", async () => {
    const { status, html } = await page(await signIn("head-coach"), cardPath, {
      team: falcons.teamId,
    });
    expect(status).toBe(200);
    expect(html).toContain(SEED_CHILDREN.avery.displayName);
    expect(html).toContain(falcons.name);
  });

  for (const persona of ["stranger", "second-team-guardian"] as const) {
    it(`answers ${persona} a rendered 404 page with no team or child data`, async () => {
      const { status, html } = await page(await signIn(persona), cardPath, {
        team: falcons.teamId,
      });
      expect(status).toBe(404);
      expect(html).toContain(NOT_FOUND_TEXT);
      expect(executableInlineScripts(html)).toEqual([]);
      expect(html).not.toContain("data-stck");
      expect(html).not.toContain('aria-busy="true"');
      for (const id of [falcons.teamId, falcons.seasonId, SEED_CHILDREN.avery.participantId]) {
        expect(html).not.toContain(id);
      }
      expect(html).not.toContain(falcons.name);
      for (const child of Object.values(SEED_CHILDREN)) {
        expect(html).not.toContain(child.displayName);
      }
    });
  }
});
