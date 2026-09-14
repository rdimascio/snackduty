import { DevScenarioApi, devScenarioError } from "./dev-scenario-api";
import type { DevScenarioTeam } from "./dev-scenario-api";

const COACHED_TEAM = "Scenario Falcons";
const FAMILY_TEAM = "Scenario Comets";
const COACHED_PLAYER = { displayName: "Avery Scenario", birthDate: "2018-04-09" } as const;
const FAMILY_PLAYER = { displayName: "Jordan Scenario", birthDate: "2019-05-14" } as const;

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
  timeZone: "America/Los_Angeles",
});

async function createTeamScenario(
  api: DevScenarioApi,
  ownerCookie: string,
  memberCookie: string,
  input: {
    readonly teamName: string;
    readonly seasonLabel: string;
    readonly player: { readonly displayName: string; readonly birthDate: string };
  },
): Promise<DevScenarioTeam> {
  const teamId = await api.createTeam(ownerCookie, input.teamName);
  const seasonId = await api.createSeason(ownerCookie, teamId, season(input.seasonLabel));
  ensure("seed-team", seasonId !== undefined, "season creation returned no id");
  const playerId = await api.addPlayer(ownerCookie, teamId, seasonId, input.player);
  await api.joinParent(
    ownerCookie,
    memberCookie,
    teamId,
    playerId,
    `${input.player.displayName.split(" ")[0] ?? "Player"}'s parent`,
  );
  return {
    teamId,
    seasonId,
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
  api: DevScenarioApi,
  manifest: DevScenarioManifest,
  ownerCookie: string,
  coachParentCookie: string,
): Promise<void> {
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
  verifyPrivatePlayer(familyRoster, family);
  await api.expectOwnerOnlySurfaceHidden(coachParentCookie, coached.teamId);
  await api.createSeason(
    coachParentCookie,
    family.teamId,
    season("Cross-team mutation must fail"),
    404,
  );
}

export async function seedDevScenario(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SeededDevScenario> {
  const api = new DevScenarioApi(baseUrl, signal);
  const owner = await api.signIn("default");
  const coachParent = await api.signIn("second-adult");
  const coached = await createTeamScenario(api, owner.cookie, coachParent.cookie, {
    teamName: COACHED_TEAM,
    seasonLabel: "Coached season",
    player: COACHED_PLAYER,
  });
  const family = await createTeamScenario(api, owner.cookie, coachParent.cookie, {
    teamName: FAMILY_TEAM,
    seasonLabel: "Family season",
    player: FAMILY_PLAYER,
  });
  await api.grantCoCoach(owner.cookie, coached.teamId, coachParent.personId);

  const manifest: DevScenarioManifest = {
    webBaseUrl: baseUrl,
    nativeApiBaseUrl: baseUrl.replace("127.0.0.1", "localhost"),
    teams: { coached, family },
    personas: {
      owner: { key: "default", displayName: owner.displayName },
      coachParent: { key: "second-adult", displayName: coachParent.displayName },
    },
  };

  return {
    manifest,
    verify: () => verifySeededScenario(api, manifest, owner.cookie, coachParent.cookie),
  };
}
