import {
  DEV_SIGN_IN_PAGE_PATH,
  SEED_CALENDAR_FEED,
  SEED_CHILDREN,
  SEED_INVITATIONS,
  SEED_PERSONAS,
  SEED_TEAMS,
} from "../../apps/web/app/dev/seed-personas";
import type { SeedPersona } from "../../apps/web/app/dev/seed-personas";
import { DevScenarioApi, ensure } from "./dev-scenario-api";
import type { DevScenarioSkillCard } from "./dev-scenario-api";

const MIN_STREAK_DAYS = 3;

export interface DevScenarioManifest {
  readonly webBaseUrl: string;
  readonly nativeApiBaseUrl: string;
  readonly signInPageUrl: string;
  readonly seedFiles: readonly string[];
  readonly teams: typeof SEED_TEAMS;
  readonly personas: readonly SeedPersona[];
  readonly calendarFeedUrl: string;
  readonly invitationUrls: { readonly stranger: string; readonly caseyParent: string };
}

export function scenarioManifest(
  webBaseUrl: string,
  seedFiles: readonly string[],
): DevScenarioManifest {
  return {
    webBaseUrl,
    nativeApiBaseUrl: webBaseUrl.replace("127.0.0.1", "localhost"),
    signInPageUrl: `${webBaseUrl}${DEV_SIGN_IN_PAGE_PATH}`,
    seedFiles,
    teams: SEED_TEAMS,
    personas: SEED_PERSONAS,
    calendarFeedUrl: `${webBaseUrl}/calendar/feed/${SEED_CALENDAR_FEED.token}`,
    invitationUrls: {
      stranger: `${webBaseUrl}/invite#${SEED_INVITATIONS.stranger.token}`,
      caseyParent: `${webBaseUrl}/invite#${SEED_INVITATIONS.caseyParent.token}`,
    },
  };
}

function sameAccess(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((key) => actual[key] === expected[key]);
}

export function verifyPlayerCard(card: DevScenarioSkillCard): void {
  ensure("verify-player-card", card.scoredSkills > 0, "the seed scored no skill on the card");
  ensure("verify-player-card", card.overall > 0, "the player card overall rating is 0");
  ensure(
    "verify-player-card",
    card.streakDays >= MIN_STREAK_DAYS,
    `the player card streak is ${card.streakDays} days; expected at least ${MIN_STREAK_DAYS}`,
  );
}

async function expectStatus(url: string, expected: number, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetch(url, {
    signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
  });
  await response.arrayBuffer();
  ensure(
    "verify-seeded-page",
    response.status === expected,
    `GET ${new URL(url).pathname} answered ${response.status}; expected ${expected}`,
  );
}

export async function verifySeededScenario(
  manifest: DevScenarioManifest,
  signal?: AbortSignal,
): Promise<void> {
  const api = new DevScenarioApi(manifest.webBaseUrl, signal);
  const cookies = new Map<string, string>();
  for (const persona of manifest.personas) {
    const identity = await api.signIn(persona.key);
    ensure(
      `sign-in-${persona.key}`,
      identity.personId === persona.personId && identity.displayName === persona.displayName,
      `${persona.key} signed in as the wrong adult`,
    );
    const access = await api.teamAccess(identity.cookie);
    ensure(
      `verify-${persona.key}-teams`,
      sameAccess(access, persona.access),
      `${persona.key} sees ${JSON.stringify(access)}; expected ${JSON.stringify(persona.access)}`,
    );
    cookies.set(persona.key, identity.cookie);
  }
  const { teamId } = manifest.teams.coached;
  const { participantId } = SEED_CHILDREN.avery;
  const [parentCard, coachCard] = await Promise.all([
    api.readSkillCard(cookies.get("parent") ?? "", teamId, participantId),
    api.readSkillCard(cookies.get("head-coach") ?? "", teamId, participantId),
  ]);
  verifyPlayerCard(parentCard);
  ensure(
    "verify-coach-card",
    JSON.stringify(parentCard) === JSON.stringify(coachCard),
    "the head coach's read-only player card differs from the parent's",
  );
  await expectStatus(manifest.signInPageUrl, 200, signal);
  await expectStatus(manifest.calendarFeedUrl, 200, signal);
}
