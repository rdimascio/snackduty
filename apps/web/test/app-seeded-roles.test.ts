import { createApp } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySeed } from "../app/dev/seed-database";
import { SEED_CHILDREN, SEED_TEAMS, SEED_TIME_ZONE } from "../app/dev/seed-personas";
import type { SeedPersonaKey } from "../app/dev/seed-personas";
import { registerDevSignIn } from "../app/dev/sign-in";
import { createApplication } from "../app/lib/server/composition";
import { identityServices } from "../app/lib/server/identity";
import { devInviteDeliverer } from "../app/lib/server/invite-delivery";
import { ageOn, localDateIn } from "../app/roster/age";
import { registerRuntimePages } from "../runtime/web-surface";

type Handle = Awaited<ReturnType<typeof createApp>>["handle"];

const sameOrigin = { "sec-fetch-site": "same-origin" };
const NOT_FOUND_TEXT = "That page isn't on the roster";

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
    clock: Date.now,
    mode: "development",
    developmentSignIn: true,
    inviteDelivery: devInviteDeliverer(),
  });
  await registerRuntimePages(config.app);
  const app = registerDevSignIn(config.app, { enabled: true, db, sessions });
  handle = (await createApp({ ...config, app })).handle;
  await applySeed(opened.db);
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
  const avery = { name: SEED_CHILDREN.avery.displayName, birthDate: "2018-04-10" };

  for (const persona of ["head-coach", "co-coach"] as const) {
    it(`shows ${persona} each child's age and no birth date`, async () => {
      const { status, html } = await page(await signIn(persona), "/app");
      expect(status).toBe(200);
      expect(html).toContain(SEED_TEAMS.coached.name);
      expect(seededBirthDates).toContainEqual(avery);

      const today = localDateIn(Date.now(), SEED_TIME_ZONE);
      const coached = seededBirthDates.filter((child) => html.includes(child.name));
      expect(coached.map((child) => child.name)).toContain(avery.name);
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

  for (const path of [
    "/app/roster",
    "/app/duties",
    `/app/roster/${SEED_CHILDREN.avery.participantId}`,
  ]) {
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
