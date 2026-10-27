import { DEV_PERSONAS } from "../lib/server/identity";

export interface SeedPersona {
  readonly key: string;
  readonly personId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly can: string;
  readonly access: Readonly<Record<string, "manage" | "read">>;
}

export const SEED_TIME_ZONE = "America/Phoenix";

export const SEED_TEAMS = {
  coached: {
    teamId: "team_seed_falcons",
    seasonId: "season_seed_falcons",
    name: "Scenario Falcons",
    seasonLabel: "Fall season",
  },
  second: {
    teamId: "team_seed_comets",
    seasonId: "season_seed_comets",
    name: "Scenario Comets",
    seasonLabel: "Fall season",
  },
} as const;

export const SEED_CHILDREN = {
  avery: { participantId: "participant_seed_avery", displayName: "Avery Scenario" },
  blake: { participantId: "participant_seed_blake", displayName: "Blake Scenario" },
  casey: { participantId: "participant_seed_casey", displayName: "Casey Scenario" },
  jordan: { participantId: "participant_seed_jordan", displayName: "Jordan Scenario" },
  quinn: { participantId: "participant_seed_quinn", displayName: "Quinn Scenario" },
} as const;

export const SEED_PERSONAS = [
  {
    key: "head-coach",
    personId: "person_seed_head_coach",
    accountId: "account_seed_head_coach",
    displayName: "Hana Headcoach",
    email: "head-coach@snackday.test",
    role: "Team owner (head coach)",
    can: "Owns the Falcons: roster, guardians, invitations, schedule, duty slots, co-coach grants, read-only player cards.",
    access: { [SEED_TEAMS.coached.teamId]: "manage" },
  },
  {
    key: "co-coach",
    personId: "person_seed_co_coach",
    accountId: "account_seed_co_coach",
    displayName: "Cole Cocoach",
    email: "co-coach@snackday.test",
    role: "Co-coach",
    can: "Manages the Falcons schedule, roster and duties; reads player cards; cannot invite or grant roles.",
    access: { [SEED_TEAMS.coached.teamId]: "manage" },
  },
  {
    key: "parent",
    personId: "person_seed_parent",
    accountId: "account_seed_parent",
    displayName: "Pat Parent",
    email: "parent@snackday.test",
    role: "Parent of two Falcons",
    can: "Guardian of Avery and Blake: RSVPs, claims duties, answers lessons, owns their player cards and calendar feed.",
    access: { [SEED_TEAMS.coached.teamId]: "read" },
  },
  {
    key: "second-team-guardian",
    personId: "person_seed_second_team_guardian",
    accountId: "account_seed_second_team_guardian",
    displayName: "Gwen Guardian",
    email: "second-team-guardian@snackday.test",
    role: "Guardian on the second team only",
    can: "Guardian of Quinn on the Comets; sees nothing of the Falcons.",
    access: { [SEED_TEAMS.second.teamId]: "read" },
  },
  {
    key: "team-member",
    personId: "person_seed_team_member",
    accountId: "account_seed_team_member",
    displayName: "Max Member",
    email: "team-member@snackday.test",
    role: "Adult team member, no child",
    can: "Reads the Falcons schedule and roster names; claims duty slots; no child data.",
    access: { [SEED_TEAMS.coached.teamId]: "read" },
  },
  {
    key: "stranger",
    personId: "person_seed_stranger",
    accountId: "account_seed_stranger",
    displayName: "Sid Stranger",
    email: "stranger@snackday.test",
    role: "Signed-in adult with no team",
    can: "Sees no team; holds one pending Falcons invitation to accept.",
    access: {},
  },
  {
    key: "default",
    personId: DEV_PERSONAS.default.personId,
    accountId: DEV_PERSONAS.default.accountId,
    displayName: DEV_PERSONAS.default.displayName,
    email: "development-adult@snackday.test",
    role: "Comets owner (iOS default persona)",
    can: "Owns the Comets; the iOS live tests and a sign-in with no body use this adult.",
    access: { [SEED_TEAMS.second.teamId]: "manage" },
  },
  {
    key: "second-adult",
    personId: DEV_PERSONAS["second-adult"].personId,
    accountId: DEV_PERSONAS["second-adult"].accountId,
    displayName: DEV_PERSONAS["second-adult"].displayName,
    email: "second-adult@snackday.test",
    role: "Falcons co-coach and Comets parent (iOS second persona)",
    can: "Co-coaches the Falcons and is Jordan's guardian on the Comets; the iOS live tests use this adult.",
    access: { [SEED_TEAMS.coached.teamId]: "manage", [SEED_TEAMS.second.teamId]: "read" },
  },
] as const satisfies readonly SeedPersona[];

export type SeedPersonaKey = (typeof SEED_PERSONAS)[number]["key"];

export const SEED_PERSONA_KEYS: readonly SeedPersonaKey[] = SEED_PERSONAS.map(
  (persona) => persona.key,
);

const FRAMEWORK_PERSONA_KEYS: ReadonlySet<string> = new Set(Object.keys(DEV_PERSONAS));

export function seedPersona(key: string): SeedPersona | undefined {
  return SEED_PERSONAS.find((persona) => persona.key === key);
}

export function isSeedOnlyPersona(key: string): boolean {
  return seedPersona(key) !== undefined && !FRAMEWORK_PERSONA_KEYS.has(key);
}

export const SEED_INVITATIONS = {
  stranger: {
    id: "invitation_seed_stranger",
    token: "5eed000000000000000000000000000000000000000000000000000000000001",
  },
  caseyParent: {
    id: "invitation_seed_casey_parent",
    token: "5eed000000000000000000000000000000000000000000000000000000000002",
  },
} as const;

export const SEED_CALENDAR_FEED = {
  id: "calendar_feed_seed_parent",
  personaKey: "parent",
  teamId: SEED_TEAMS.coached.teamId,
  token: "5eed000000000000000000000000000000000000000000000000000000000003",
} as const;

export const SEED_SCHEDULE = {
  practiceTitle: "Practice",
  gameTitles: [
    "Game vs. Scenario Hawks (home)",
    "Game at Scenario Owls (away)",
    "Game vs. Scenario Rays (home)",
  ],
  cancelledGameTitle: "Game vs. Scenario Rays (home)",
  gameDuties: ["Snacks", "Scorebook", "Field setup"],
  secondTeamEventTitle: "Sunday skills clinic",
} as const;

export const DEV_SIGN_IN_PAGE_PATH = "/dev/sign-in";
