import { devScenarioError } from "./dev-scenario-api";
import type { DevScenarioIdentity, DevScenarioTeam } from "./dev-scenario-api";
import {
  DevScenarioEventApi,
  SCENARIO_RSVPS,
  seedScenarioEvents,
  verifyScenarioEvents,
} from "./dev-scenario-events";
import type { ScenarioEventSummary, ScenarioSeasonWindow } from "./dev-scenario-events";
import type { DevScenarioSkillCard } from "./dev-scenario-lessons";
import { SCENARIO_DRILL_DAYS, scenarioSkillEvents } from "./dev-scenario-skill-events";

const COACHED_TEAM = "Scenario Falcons";
const FAMILY_TEAM = "Scenario Comets";
const COACHED_PLAYER = { displayName: "Avery Scenario", birthDate: "2018-04-09" } as const;
const FAMILY_PLAYER = { displayName: "Jordan Scenario", birthDate: "2019-05-14" } as const;
const OWNER_CHILD = { displayName: "Riley Scenario", birthDate: "2018-08-21" } as const;
const UNLINKED_PLAYER = { displayName: "Casey Scenario", birthDate: "2018-11-03" } as const;
const SCENARIO_TIME_ZONE = "America/Los_Angeles";
const MIN_STREAK_DAYS = 3;

export interface DevScenarioManifest {
  readonly webBaseUrl: string;
  readonly nativeApiBaseUrl: string;
  readonly teams: {
    readonly coached: DevScenarioTeam;
    readonly family: DevScenarioTeam;
  };
  readonly personas: {
    readonly owner: { readonly key: "default"; readonly displayName: string };
    readonly coachParent: { readonly key: "second-adult"; readonly displayName: string };
  };
  readonly skillEvents: { readonly drillDays: number; readonly posted: number };
  readonly events: ScenarioEventSummary;
}

export interface SeededDevScenario {
  readonly manifest: DevScenarioManifest;
  verify(): Promise<void>;
}

function ensure(step: string, condition: boolean, message: string): asserts condition {
  if (!condition) throw devScenarioError(step, message);
}

function dateDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

const season = (label: string) => ({
  label,
  startDate: dateDaysFromNow(-30),
  endDate: dateDaysFromNow(120),
  timeZone: SCENARIO_TIME_ZONE,
});

interface PlayerSeed {
  readonly displayName: string;
  readonly birthDate: string;
}

interface TeamScenario extends DevScenarioTeam {
  readonly season: ScenarioSeasonWindow;
}

interface TeamListEntry {
  readonly team?: { readonly id?: string; readonly name?: string };
  readonly access?: string;
  readonly seasons?: readonly {
    readonly id?: string;
    readonly label?: string;
    readonly startDate?: string;
    readonly endDate?: string;
    readonly timeZone?: string;
  }[];
}

async function ensureTeam(
  api: DevScenarioEventApi,
  ownerCookie: string,
  teamName: string,
  seasonLabel: string,
): Promise<{ readonly teamId: string; readonly seasonId: string; season: ScenarioSeasonWindow }> {
  const { teams = [] } = (await api.listTeams(ownerCookie)) as {
    teams?: readonly TeamListEntry[];
  };
  const entry = teams.find(
    (candidate) => candidate.team?.name === teamName && candidate.access === "manage",
  );
  const teamId = entry?.team?.id ?? (await api.createTeam(ownerCookie, teamName));
  const existing = entry?.seasons?.find((candidate) => candidate.label === seasonLabel);
  if (
    existing?.id !== undefined &&
    existing.startDate !== undefined &&
    existing.endDate !== undefined &&
    existing.timeZone !== undefined
  ) {
    return {
      teamId,
      seasonId: existing.id,
      season: {
        startDate: existing.startDate,
        endDate: existing.endDate,
        timeZone: existing.timeZone,
      },
    };
  }
  const window = season(seasonLabel);
  const seasonId = await api.createSeason(ownerCookie, teamId, window);
  ensure("seed-team", seasonId !== undefined, "season creation returned no id");
  return { teamId, seasonId, season: window };
}

async function ensurePlayer(
  api: DevScenarioEventApi,
  ownerCookie: string,
  team: { readonly teamId: string; readonly seasonId: string },
  player: PlayerSeed,
  guardian?: DevScenarioIdentity,
): Promise<string> {
  const roster = await api.readSeasonRoster(ownerCookie, team.teamId, team.seasonId);
  const existing = roster.find((entry) => entry.displayName === player.displayName);
  const playerId =
    existing?.participantId ??
    (await api.addPlayer(ownerCookie, team.teamId, team.seasonId, player));
  const linked = existing?.guardians?.some((entry) => entry.displayName === guardian?.displayName);
  if (guardian !== undefined && linked !== true) {
    await api.joinParent(
      ownerCookie,
      guardian.cookie,
      team.teamId,
      playerId,
      `${player.displayName.split(" ")[0] ?? "Player"}'s parent`,
    );
  }
  return playerId;
}

async function createTeamScenario(
  api: DevScenarioEventApi,
  ownerCookie: string,
  member: DevScenarioIdentity,
  input: {
    readonly teamName: string;
    readonly seasonLabel: string;
    readonly player: PlayerSeed;
  },
): Promise<TeamScenario> {
  const team = await ensureTeam(api, ownerCookie, input.teamName, input.seasonLabel);
  const playerId = await ensurePlayer(api, ownerCookie, team, input.player, member);
  return {
    ...team,
    playerId,
    name: input.teamName,
    seasonLabel: input.seasonLabel,
    playerName: input.player.displayName,
  };
}

function findTeamAccess(
  body: { teams?: readonly Record<string, unknown>[] },
  teamId: string,
): string | undefined {
  const entry = body.teams?.find((candidate) => {
    const team = candidate["team"] as { id?: string } | undefined;
    return team?.id === teamId;
  });
  return typeof entry?.["access"] === "string" ? entry["access"] : undefined;
}

function verifyPrivatePlayer(body: { roster?: readonly unknown[] }, team: DevScenarioTeam): void {
  const roster = body.roster as
    | readonly {
        participantId?: string;
        displayName?: string;
        birthDate?: string;
        guardians?: readonly { displayName?: string }[];
      }[]
    | undefined;
  const player = roster?.find((entry) => entry.participantId === team.playerId);
  ensure("verify-roster", player !== undefined, `${team.name} is missing its synthetic player`);
  ensure(
    "verify-roster",
    player.displayName === team.playerName && typeof player.birthDate === "string",
    `${team.name} did not return the parent-authorized player detail`,
  );
  ensure(
    "verify-roster",
    player.guardians?.some((guardian) => guardian.displayName === "Second Development Adult") ===
      true,
    `${team.name} did not retain the parent relationship`,
  );
}

async function verifySeededScenario(
  api: DevScenarioEventApi,
  manifest: DevScenarioManifest,
  owner: DevScenarioIdentity,
  coachParent: DevScenarioIdentity,
): Promise<void> {
  const ownerCookie = owner.cookie;
  const coachParentCookie = coachParent.cookie;
  const { coached, family } = manifest.teams;
  const [ownerTeams, coachTeams, coachedRoster, familyRoster] = await Promise.all([
    api.listTeams(ownerCookie),
    api.listTeams(coachParentCookie),
    api.readRoster(coachParentCookie, coached),
    api.readRoster(coachParentCookie, family),
  ]);
  ensure(
    "verify-owner-teams",
    findTeamAccess(ownerTeams, coached.teamId) === "manage" &&
      findTeamAccess(ownerTeams, family.teamId) === "manage",
    "the owner cannot manage both scenario teams",
  );
  ensure(
    "verify-coach-scope",
    findTeamAccess(coachTeams, coached.teamId) === "manage" &&
      findTeamAccess(coachTeams, family.teamId) === "read",
    "the second adult's coach grant is not isolated to one team",
  );
  verifyPrivatePlayer(coachedRoster, coached);
  const [parentCard, ownerCard] = await Promise.all([
    api.readSkillCard(coachParentCookie, coached.teamId, coached.playerId),
    api.readSkillCard(ownerCookie, coached.teamId, coached.playerId),
  ]);
  verifyPlayerCard(parentCard);
  verifyPlayerCard(ownerCard);
  ensure(
    "verify-coach-card",
    JSON.stringify(ownerCard) === JSON.stringify(parentCard),
    "the owner's read-only player card differs from the parent's",
  );
  verifyPrivatePlayer(familyRoster, family);
  await api.expectOwnerOnlySurfaceHidden(coachParentCookie, coached.teamId);
  await api.createSeason(
    coachParentCookie,
    family.teamId,
    season("Cross-team mutation must fail"),
    404,
  );
  await verifyScenarioEvents(
    api,
    {
      owner: { personId: owner.personId, cookie: owner.cookie },
      parent: { personId: coachParent.personId, cookie: coachParent.cookie },
    },
    coached,
    family,
  );
}

export function verifyPlayerCard(card: DevScenarioSkillCard): void {
  ensure("verify-player-card", card.areas.length > 0, "the player card carries no areas");
  ensure(
    "verify-player-card",
    card.scoredSkills > 0,
    "the seeded events did not score any skill on the player card",
  );
  ensure("verify-player-card", card.overall > 0, "the player card overall rating is 0");
  ensure(
    "verify-player-card",
    card.streakDays >= MIN_STREAK_DAYS,
    `the player card streak is ${card.streakDays} days; expected at least ${MIN_STREAK_DAYS}`,
  );
}

async function seedTrainingWeek(
  api: DevScenarioEventApi,
  guardianCookie: string,
  team: DevScenarioTeam,
): Promise<number> {
  const events = scenarioSkillEvents(team.playerId, Date.now(), SCENARIO_TIME_ZONE);
  const card = await api.readSkillCard(guardianCookie, team.teamId, team.playerId);
  if (card.scoredSkills > 0) return events.length;
  await api.seedSkillEvents(guardianCookie, team.teamId, team.playerId, events);
  return events.length;
}

function teamManifest(team: TeamScenario): DevScenarioTeam {
  return {
    teamId: team.teamId,
    seasonId: team.seasonId,
    playerId: team.playerId,
    name: team.name,
    seasonLabel: team.seasonLabel,
    playerName: team.playerName,
  };
}

export async function seedDevScenario(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SeededDevScenario> {
  const api = new DevScenarioEventApi(baseUrl, signal);
  const owner = await api.signIn("default");
  const coachParent = await api.signIn("second-adult");
  const coachedScenario = await createTeamScenario(api, owner.cookie, coachParent, {
    teamName: COACHED_TEAM,
    seasonLabel: "Coached season",
    player: COACHED_PLAYER,
  });
  const familyScenario = await createTeamScenario(api, owner.cookie, coachParent, {
    teamName: FAMILY_TEAM,
    seasonLabel: "Family season",
    player: FAMILY_PLAYER,
  });
  const ownerChildId = await ensurePlayer(api, owner.cookie, coachedScenario, OWNER_CHILD, owner);
  await ensurePlayer(api, owner.cookie, coachedScenario, UNLINKED_PLAYER);
  await api.grantCoCoach(owner.cookie, coachedScenario.teamId, coachParent.personId);
  const coached = teamManifest(coachedScenario);
  const family = teamManifest(familyScenario);
  const posted = await seedTrainingWeek(api, coachParent.cookie, coached);
  const events = await seedScenarioEvents({
    api,
    nowMs: Date.now(),
    adults: {
      owner: { personId: owner.personId, cookie: owner.cookie },
      parent: { personId: coachParent.personId, cookie: coachParent.cookie },
    },
    coached: coachedScenario,
    family: familyScenario,
    rsvps: [
      {
        participantId: coached.playerId,
        guardian: "parent",
        statuses: SCENARIO_RSVPS.parentChild,
      },
      { participantId: ownerChildId, guardian: "owner", statuses: SCENARIO_RSVPS.ownerChild },
    ],
    familyRsvp: { participantId: family.playerId, guardian: "parent" },
  });

  const manifest: DevScenarioManifest = {
    webBaseUrl: baseUrl,
    nativeApiBaseUrl: baseUrl.replace("127.0.0.1", "localhost"),
    teams: { coached, family },
    personas: {
      owner: { key: "default", displayName: owner.displayName },
      coachParent: { key: "second-adult", displayName: coachParent.displayName },
    },
    skillEvents: { drillDays: SCENARIO_DRILL_DAYS, posted },
    events,
  };

  return {
    manifest,
    verify: () => verifySeededScenario(api, manifest, owner, coachParent),
  };
}
