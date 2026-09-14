export interface DevScenarioError extends Error {
  readonly step: string;
}

export function devScenarioError(step: string, message: string): DevScenarioError {
  return Object.assign(new Error(`${step}: ${message}`), { step });
}

export function isDevScenarioError(error: unknown): error is DevScenarioError {
  return error instanceof Error && "step" in error;
}

function ensure(step: string, condition: boolean, message: string): asserts condition {
  if (!condition) throw devScenarioError(step, message);
}

interface IdentityResponse {
  readonly person?: { readonly id?: string; readonly displayName?: string };
}

interface TeamResponse {
  readonly team?: { readonly id?: string; readonly name?: string };
}

interface SeasonResponse {
  readonly season?: { readonly id?: string; readonly label?: string };
}

interface ParticipantResponse {
  readonly participant?: {
    readonly participantId?: string;
    readonly displayName?: string;
    readonly birthDate?: string;
  };
}

export interface DevScenarioIdentity {
  readonly personId: string;
  readonly displayName: string;
  readonly cookie: string;
}

export interface DevScenarioTeam {
  readonly teamId: string;
  readonly seasonId: string;
  readonly playerId: string;
  readonly name: string;
  readonly seasonLabel: string;
  readonly playerName: string;
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

  private async json<T>(
    step: string,
    path: string,
    init: RequestInit,
    expectedStatus: number,
  ): Promise<T> {
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

  private mutation(cookie?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    };
  }

  async signIn(persona: "default" | "second-adult"): Promise<DevScenarioIdentity> {
    const step = `sign-in-${persona}`;
    const response = await fetch(`${this.baseUrl}/api/dev/sign-in`, {
      method: "POST",
      headers: this.mutation(),
      signal: this.requestSignal(),
      ...(persona === "default" ? {} : { body: JSON.stringify({ persona }) }),
    });
    ensure(step, response.status === 200, `POST /api/dev/sign-in answered ${response.status}`);
    const setCookie = response.headers.get("set-cookie");
    ensure(
      step,
      setCookie?.startsWith("snackday_session_dev=") === true,
      "development sign-in did not set its HttpOnly session cookie",
    );
    const cookie = setCookie.split(";", 1)[0];
    ensure(step, cookie !== undefined, "development session cookie is empty");
    const identity = (await response.json()) as IdentityResponse;
    ensure(step, typeof identity.person?.id === "string", "identity carries no person id");
    ensure(
      step,
      typeof identity.person.displayName === "string",
      "identity carries no display name",
    );
    return {
      personId: identity.person.id,
      displayName: identity.person.displayName,
      cookie,
    };
  }

  async createTeam(cookie: string, name: string): Promise<string> {
    const body = await this.json<TeamResponse>(
      "create-team",
      "/api/teams",
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify({ name }) },
      201,
    );
    ensure("create-team", typeof body.team?.id === "string", "response carries no team id");
    ensure("create-team", body.team.name === name, "response carries the wrong team name");
    return body.team.id;
  }

  async createSeason(
    cookie: string,
    teamId: string,
    season: {
      readonly label: string;
      readonly startDate: string;
      readonly endDate: string;
      readonly timeZone: string;
    },
    expectedStatus = 201,
  ): Promise<string | undefined> {
    const body = await this.json<SeasonResponse | { error?: string }>(
      "create-season",
      `/api/teams/${teamId}/seasons`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(season) },
      expectedStatus,
    );
    if (expectedStatus !== 201) return undefined;
    const created = body as SeasonResponse;
    ensure(
      "create-season",
      typeof created.season?.id === "string",
      "response carries no season id",
    );
    return created.season.id;
  }

  async addPlayer(
    cookie: string,
    teamId: string,
    seasonId: string,
    player: { readonly displayName: string; readonly birthDate: string },
  ): Promise<string> {
    const body = await this.json<ParticipantResponse>(
      "add-player",
      `/api/teams/${teamId}/seasons/${seasonId}/participants`,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify(player) },
      201,
    );
    ensure(
      "add-player",
      typeof body.participant?.participantId === "string",
      "response carries no participant id",
    );
    ensure(
      "add-player",
      body.participant.displayName === player.displayName &&
        body.participant.birthDate === player.birthDate,
      "response carries the wrong synthetic player",
    );
    return body.participant.participantId;
  }

  async joinParent(
    ownerCookie: string,
    memberCookie: string,
    teamId: string,
    participantId: string,
    inviteeLabel: string,
  ): Promise<void> {
    const created = await this.json<{ invitation?: { inviteUrl?: string } }>(
      "create-parent-invitation",
      `/api/teams/${teamId}/invitations`,
      {
        method: "POST",
        headers: this.mutation(ownerCookie),
        body: JSON.stringify({
          invitedRole: "adult",
          inviteeLabel,
          participantId,
          relationship: "parent",
        }),
      },
      201,
    );
    const link = created.invitation?.inviteUrl;
    ensure(
      "create-parent-invitation",
      typeof link === "string" && link.startsWith("/invite#"),
      "invitation response carries no fragment credential",
    );
    const token = link.slice("/invite#".length);
    ensure(
      "create-parent-invitation",
      /^[0-9a-f]{64}$/u.test(token),
      "invitation fragment has an invalid shape",
    );
    await this.json(
      "accept-parent-invitation",
      "/api/invitations/accept",
      {
        method: "POST",
        headers: this.mutation(memberCookie),
        body: JSON.stringify({ token }),
      },
      200,
    );
  }

  async grantCoCoach(ownerCookie: string, teamId: string, personId: string): Promise<void> {
    await this.json(
      "grant-co-coach",
      `/api/teams/${teamId}/adult-members/${personId}/co-coach/grant`,
      { method: "POST", headers: this.mutation(ownerCookie) },
      200,
    );
  }

  listTeams(cookie: string): Promise<{ teams?: readonly Record<string, unknown>[] }> {
    return this.json("list-teams", "/api/teams", { headers: { Cookie: cookie } }, 200);
  }

  readRoster(cookie: string, team: DevScenarioTeam): Promise<{ roster?: readonly unknown[] }> {
    return this.json(
      "read-roster",
      `/api/teams/${team.teamId}/seasons/${team.seasonId}/roster`,
      { headers: { Cookie: cookie } },
      200,
    );
  }

  async expectOwnerOnlySurfaceHidden(cookie: string, teamId: string): Promise<void> {
    await this.json(
      "verify-owner-only-surface",
      `/api/teams/${teamId}/invitations`,
      { headers: { Cookie: cookie } },
      404,
    );
  }
}
