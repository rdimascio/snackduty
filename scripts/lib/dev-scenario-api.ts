export interface DevScenarioError extends Error {
  readonly step: string;
}

export function devScenarioError(step: string, message: string): DevScenarioError {
  return Object.assign(new Error(`${step}: ${message}`), { step });
}

export function isDevScenarioError(error: unknown): error is DevScenarioError {
  return error instanceof Error && "step" in error;
}

export function ensure(step: string, condition: boolean, message: string): asserts condition {
  if (!condition) throw devScenarioError(step, message);
}

interface IdentityResponse {
  readonly person?: { readonly id?: string; readonly displayName?: string };
}

interface TeamListResponse {
  readonly teams?: readonly {
    readonly team?: { readonly id?: string };
    readonly access?: string;
  }[];
}

interface SkillCardResponse {
  readonly overall?: number;
  readonly skills?: readonly { readonly streakAtLast?: number; readonly points?: number }[];
}

export interface DevScenarioIdentity {
  readonly personId: string;
  readonly displayName: string;
  readonly cookie: string;
}

export interface DevScenarioSkillCard {
  readonly overall: number;
  readonly streakDays: number;
  readonly scoredSkills: number;
}

export class DevScenarioApi {
  constructor(
    readonly baseUrl: string,
    private readonly signal?: AbortSignal,
  ) {}

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(5_000);
    return this.signal === undefined ? timeout : AbortSignal.any([timeout, this.signal]);
  }

  async json<T>(step: string, path: string, init: RequestInit, expectedStatus: number): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: this.requestSignal(),
    });
    ensure(
      step,
      response.status === expectedStatus,
      `${init.method ?? "GET"} ${path} answered ${response.status}; expected ${expectedStatus}`,
    );
    try {
      return (await response.json()) as T;
    } catch {
      throw devScenarioError(step, `${path} returned invalid JSON`);
    }
  }

  async signIn(persona: string): Promise<DevScenarioIdentity> {
    const step = `sign-in-${persona}`;
    const response = await fetch(`${this.baseUrl}/api/dev/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ persona }),
      signal: this.requestSignal(),
    });
    ensure(step, response.status === 200, `POST /api/dev/sign-in answered ${response.status}`);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    ensure(
      step,
      cookie?.startsWith("snackday_session_dev=") === true,
      "development sign-in did not set its HttpOnly session cookie",
    );
    const identity = (await response.json()) as IdentityResponse;
    ensure(step, typeof identity.person?.id === "string", "identity carries no person id");
    ensure(
      step,
      typeof identity.person.displayName === "string",
      "identity carries no display name",
    );
    return { personId: identity.person.id, displayName: identity.person.displayName, cookie };
  }

  async teamAccess(cookie: string): Promise<Record<string, string>> {
    const body = await this.json<TeamListResponse>(
      "list-teams",
      "/api/teams",
      { headers: { Cookie: cookie } },
      200,
    );
    return Object.fromEntries(
      (body.teams ?? []).flatMap((entry) =>
        typeof entry.team?.id === "string" && typeof entry.access === "string"
          ? [[entry.team.id, entry.access]]
          : [],
      ),
    );
  }

  async readSkillCard(
    cookie: string,
    teamId: string,
    participantId: string,
  ): Promise<DevScenarioSkillCard> {
    const step = "read-skill-card";
    const body = await this.json<SkillCardResponse>(
      step,
      `/api/teams/${teamId}/participants/${participantId}/skill-card`,
      { headers: { Cookie: cookie } },
      200,
    );
    ensure(step, typeof body.overall === "number", "response carries no overall rating");
    const skills = body.skills ?? [];
    const streakDays = Math.max(
      0,
      ...skills.map((skill) => (typeof skill.streakAtLast === "number" ? skill.streakAtLast : 0)),
    );
    const scoredSkills = skills.filter(
      (skill) => typeof skill.points === "number" && skill.points > 0,
    ).length;
    return { overall: body.overall, streakDays, scoredSkills };
  }
}
