export interface FetchResult {
  readonly status: number;
  json(): Promise<unknown>;
}

export type Fetcher = (
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: string },
) => Promise<FetchResult>;

export const browserFetcher: Fetcher = (path, init) =>
  fetch(path, {
    method: init.method,
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: init.body }),
  });

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const offline = "We could not reach Snackday. Check your connection and try again.";

function failure<T>(status: number, message: string): ActionResult<T> {
  return { ok: false, status, message };
}

async function call<T>(
  fetcher: Fetcher,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  messages: Readonly<Record<number, string>>,
  read: (payload: unknown) => T,
): Promise<ActionResult<T>> {
  let response: FetchResult;
  try {
    response = await fetcher(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return failure(0, offline);
  }
  if (response.status >= 200 && response.status < 300) {
    try {
      return { ok: true, value: read(await response.json()) };
    } catch {
      return failure(response.status, "Snackday sent an answer we could not read. Try again.");
    }
  }
  if (response.status === 401) return failure(401, "Your session ended. Sign in again.");
  if (response.status === 429)
    return failure(429, "Too many requests. Wait a moment and try again.");
  return failure(
    response.status,
    messages[response.status] ?? "Something went wrong. Try again in a moment.",
  );
}

function teamPath(teamId: string, rest: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}${rest}`;
}

function field(payload: unknown, ...path: string[]): unknown {
  let value = payload;
  for (const key of path) {
    if (typeof value !== "object" || value === null) throw new Error(`missing ${key}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function text(payload: unknown, ...path: string[]): string {
  const value = field(payload, ...path);
  if (typeof value !== "string") throw new Error(`expected text at ${path.join(".")}`);
  return value;
}

export interface SeasonInput {
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly timeZone: string;
}

export function createSeason(
  fetcher: Fetcher,
  teamId: string,
  input: SeasonInput,
): Promise<ActionResult<{ seasonId: string }>> {
  return call(
    fetcher,
    teamPath(teamId, "/seasons"),
    "POST",
    input,
    {
      400: "Check the season details and try again.",
      404: "You can no longer manage this team.",
      422: "Check the season details. The end date must not be before the start date.",
    },
    (payload) => ({ seasonId: text(payload, "season", "id") }),
  );
}

export function setCoCoach(
  fetcher: Fetcher,
  teamId: string,
  personId: string,
  grant: boolean,
): Promise<ActionResult<{ role: "coach" | "adult" }>> {
  return call(
    fetcher,
    teamPath(
      teamId,
      `/adult-members/${encodeURIComponent(personId)}/co-coach/${grant ? "grant" : "revoke"}`,
    ),
    "POST",
    undefined,
    {
      404: "This adult is no longer on the team, or you are not its owner.",
      409: "An owner's role cannot change.",
    },
    (payload) => {
      const role = text(payload, "membership", "role");
      if (role !== "coach" && role !== "adult") throw new Error("unexpected role");
      return { role };
    },
  );
}

export interface InvitationView {
  readonly id: string;
  readonly inviteeLabel: string;
  readonly invitedRole: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly forChild: boolean;
}

function invitationFrom(payload: unknown): InvitationView & { readonly inviteUrl?: string } {
  const link = field(payload, "inviteUrl");
  return {
    id: text(payload, "id"),
    inviteeLabel: text(payload, "inviteeLabel"),
    invitedRole: text(payload, "invitedRole"),
    status: text(payload, "status"),
    expiresAt: text(payload, "expiresAt"),
    forChild: field(payload, "participantId") !== undefined,
    ...(typeof link === "string" ? { inviteUrl: link } : {}),
  };
}

export interface InvitationInput {
  readonly inviteeLabel: string;
  readonly invitedRole: "adult" | "owner";
  readonly email: string;
}

const invitationMessages = {
  400: "Check the invitation details and try again.",
  404: "You are no longer an owner of this team.",
  409: "An invitation for this name is already pending. Resend it instead.",
  422: "Check the name and email address. The email must be a valid address.",
  503: "Invitation delivery is not available right now. Try again later.",
} as const;

export function sendInvitation(
  fetcher: Fetcher,
  teamId: string,
  input: InvitationInput,
): Promise<ActionResult<InvitationView & { readonly inviteUrl?: string }>> {
  return call(
    fetcher,
    teamPath(teamId, "/invitations"),
    "POST",
    {
      invitedRole: input.invitedRole,
      inviteeLabel: input.inviteeLabel,
      recipientBinding: { kind: "verified_email", email: input.email },
    },
    invitationMessages,
    (payload) => invitationFrom(field(payload, "invitation")),
  );
}

export function resendInvitation(
  fetcher: Fetcher,
  teamId: string,
  invitationId: string,
): Promise<ActionResult<InvitationView & { readonly inviteUrl?: string }>> {
  return call(
    fetcher,
    teamPath(teamId, `/invitations/${encodeURIComponent(invitationId)}/resend`),
    "POST",
    {},
    {
      ...invitationMessages,
      404: "This invitation no longer exists.",
      409: "Only a pending invitation can be resent.",
    },
    (payload) => invitationFrom(field(payload, "invitation")),
  );
}

export function revokeInvitation(
  fetcher: Fetcher,
  teamId: string,
  invitationId: string,
): Promise<ActionResult<InvitationView>> {
  return call(
    fetcher,
    teamPath(teamId, `/invitations/${encodeURIComponent(invitationId)}/revoke`),
    "POST",
    undefined,
    { 404: "This invitation no longer exists.", 409: "This invitation was already accepted." },
    (payload) => invitationFrom(field(payload, "invitation")),
  );
}

export function listInvitations(
  fetcher: Fetcher,
  teamId: string,
): Promise<ActionResult<InvitationView[]>> {
  return call(
    fetcher,
    teamPath(teamId, "/invitations"),
    "GET",
    undefined,
    { 404: "You are no longer an owner of this team." },
    (payload) => {
      const rows = field(payload, "invitations");
      if (!Array.isArray(rows)) throw new Error("expected invitations");
      return rows.map((row: unknown) => {
        const { inviteUrl: _link, ...view } = invitationFrom(row);
        return view;
      });
    },
  );
}

const feedMessages = {
  404: "Calendar feeds are not available for this team here.",
} as const;

export function createCalendarFeed(
  fetcher: Fetcher,
  teamId: string,
): Promise<ActionResult<{ path: string }>> {
  return call(
    fetcher,
    teamPath(teamId, "/calendar-feed"),
    "POST",
    undefined,
    feedMessages,
    (payload) => {
      const path = text(payload, "feed", "url");
      if (!path.startsWith("/calendar/feed/")) throw new Error("unexpected feed path");
      return { path };
    },
  );
}

export function revokeCalendarFeed(
  fetcher: Fetcher,
  teamId: string,
): Promise<ActionResult<{ revoked: true }>> {
  return call(
    fetcher,
    teamPath(teamId, "/calendar-feed/revoke"),
    "POST",
    undefined,
    feedMessages,
    (payload) => {
      if (text(payload, "feed", "status") !== "revoked") throw new Error("feed not revoked");
      return { revoked: true as const };
    },
  );
}
