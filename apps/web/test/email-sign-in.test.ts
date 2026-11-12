import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recordingEmailTransport } from "../app/lib/server/email";
import type { EmailMessage, EmailTransport } from "../app/lib/server/email";
import {
  EMAIL_SIGN_IN_LIMIT_PER_WINDOW,
  EMAIL_SIGN_IN_TTL_MS,
} from "../app/lib/server/email-sign-in";
import { VERIFIED_SESSION_COOKIE } from "../app/lib/server/identity";
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";
import {
  INVITATION_SENDS_PER_PERSON_PER_WINDOW,
  INVITATION_SENDS_PER_TEAM_PER_WINDOW,
  invitationOutbox,
} from "../app/lib/server/invitation-outbox";
import { openRuntimeApplication } from "../runtime";
import type { RuntimeConfiguration } from "../runtime";

const PUBLIC_ORIGIN = "https://staging.snackduty.test";
const START = Date.parse("2026-11-07T12:00:00.000Z");
const sameOrigin = { "sec-fetch-site": "same-origin" } as const;
const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function configuration(): Promise<RuntimeConfiguration> {
  const directory = await mkdtemp(join(tmpdir(), "snackduty-email-sign-in-"));
  scratchDirectories.push(directory);
  return {
    mode: "staging",
    databasePath: join(directory, "snackduty.db"),
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: new URL(PUBLIC_ORIGIN),
    upstreamCredentialPathLoggingSafe: false,
  };
}

const NO_EMAIL_PROVIDER = null;

async function openRuntime(
  transport: EmailTransport | typeof NO_EMAIL_PROVIDER = recordingEmailTransport(),
) {
  let now = START;
  const runtime = await openRuntimeApplication(await configuration(), {
    clock: () => now,
    invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(3)),
    ...(transport === NO_EMAIL_PROVIDER ? {} : { emailTransport: transport }),
  });
  return {
    runtime,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function post(
  runtime: Awaited<ReturnType<typeof openRuntimeApplication>>,
  path: string,
  body: unknown,
  cookie?: string,
) {
  return runtime.app.handle("POST", path, {
    headers: { ...sameOrigin, ...(cookie === undefined ? {} : { cookie }) },
    body,
  });
}

function linkToken(message: EmailMessage | undefined, path: string): string {
  const match = new RegExp(`${PUBLIC_ORIGIN}${path}#([0-9a-f]{64})`, "u").exec(message?.text ?? "");
  if (match?.[1] === undefined) throw new Error(`No ${path} link in the message.`);
  return match[1];
}

function sessionCookie(setCookie: string | undefined): string {
  const pair = setCookie?.split(";")[0];
  if (pair === undefined || !pair.startsWith(`${VERIFIED_SESSION_COOKIE}=`)) {
    throw new Error("Expected a verified session cookie.");
  }
  return pair;
}

async function signIn(
  runtime: Awaited<ReturnType<typeof openRuntimeApplication>>,
  transport: ReturnType<typeof recordingEmailTransport>,
  email: string,
  displayName?: string,
) {
  const started = await post(runtime, "/api/auth/email/start", { email });
  expect(started.status).toBe(202);
  const token = linkToken(transport.messages.at(-1), "/sign-in");
  const verified = await post(runtime, "/api/auth/email/verify", {
    token,
    ...(displayName === undefined ? {} : { displayName }),
    adultConsent: true,
  });
  expect(verified.status).toBe(200);
  return { cookie: sessionCookie(verified.headers["Set-Cookie"]), token };
}

describe("email-link sign-in", () => {
  it("emails a one-time fragment link and signs the adult in with a verified session", async () => {
    const transport = recordingEmailTransport();
    const { runtime } = await openRuntime(transport);

    const { cookie, token } = await signIn(runtime, transport, "Coach@Example.test", "Casey Coach");

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]?.to).toBe("coach@example.test");
    expect(transport.messages[0]?.subject).toBe("Your Snackday sign-in link");
    const session = await runtime.app.handle("GET", "/api/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toMatchObject({ person: { displayName: "Casey Coach" } });

    const reused = await post(runtime, "/api/auth/email/verify", { token, adultConsent: true });
    expect(reused.status).toBe(401);
    await runtime.close();
  });

  it("returns the same account for the same address", async () => {
    const transport = recordingEmailTransport();
    const { runtime } = await openRuntime(transport);

    const first = await signIn(runtime, transport, "parent@example.test", "Pat Parent");
    const second = await signIn(runtime, transport, "PARENT@example.test", "Another Name");
    const identities = await Promise.all(
      [first.cookie, second.cookie].map(async (cookie) =>
        JSON.parse((await runtime.app.handle("GET", "/api/session", { headers: { cookie } })).body),
      ),
    );

    expect(identities[1]).toEqual(identities[0]);
    expect(identities[0]).toMatchObject({ person: { displayName: "Pat Parent" } });
    await runtime.close();
  });

  it("rejects an expired link", async () => {
    const transport = recordingEmailTransport();
    const { runtime, advance } = await openRuntime(transport);
    await post(runtime, "/api/auth/email/start", { email: "late@example.test" });
    const token = linkToken(transport.messages[0], "/sign-in");

    advance(EMAIL_SIGN_IN_TTL_MS);

    expect((await post(runtime, "/api/auth/email/preview", { token })).status).toBe(401);
    expect(
      (await post(runtime, "/api/auth/email/verify", { token, adultConsent: true })).status,
    ).toBe(401);
    await runtime.close();
  });

  it("stops sending after the per-address limit but answers the same way", async () => {
    const transport = recordingEmailTransport();
    const { runtime, advance } = await openRuntime(transport);
    const request = { email: "busy@example.test" };

    for (let attempt = 0; attempt <= EMAIL_SIGN_IN_LIMIT_PER_WINDOW; attempt += 1) {
      expect((await post(runtime, "/api/auth/email/start", request)).status).toBe(202);
    }
    expect(transport.messages).toHaveLength(EMAIL_SIGN_IN_LIMIT_PER_WINDOW);

    advance(EMAIL_SIGN_IN_TTL_MS);
    expect((await post(runtime, "/api/auth/email/start", request)).status).toBe(202);
    expect(transport.messages).toHaveLength(EMAIL_SIGN_IN_LIMIT_PER_WINDOW + 1);
    await runtime.close();
  });

  it("names the account before sign-in and takes consent only from the link holder", async () => {
    const transport = recordingEmailTransport();
    const { runtime } = await openRuntime(transport);
    await post(runtime, "/api/auth/email/start", { email: "pat@example.test" });
    const token = linkToken(transport.messages[0], "/sign-in");

    const preview = await post(runtime, "/api/auth/email/preview", { token });
    expect(JSON.parse(preview.body)).toEqual({ email: "pat@example.test" });
    await expect(
      post(runtime, "/api/auth/email/start", {
        email: "pat@example.test",
        displayName: "Requester Name",
        adultConsent: true,
      }),
    ).rejects.toMatchObject({ code: "WEB_VALIDATION_FAILED" });
    await expect(post(runtime, "/api/auth/email/verify", { token })).rejects.toMatchObject({
      code: "WEB_VALIDATION_FAILED",
    });

    const verified = await post(runtime, "/api/auth/email/verify", { token, adultConsent: true });
    expect(verified.status).toBe(200);
    await runtime.close();
  });

  it("answers 503 when the provider fails or no provider is configured", async () => {
    const failing = await openRuntime({ send: () => Promise.reject(new Error("down")) });
    const request = { email: "coach@example.test" };
    expect((await post(failing.runtime, "/api/auth/email/start", request)).status).toBe(503);
    await failing.runtime.close();

    const unconfigured = await openRuntime(NO_EMAIL_PROVIDER);
    expect((await post(unconfigured.runtime, "/api/auth/email/start", request)).status).toBe(503);
    await unconfigured.runtime.close();
  });
});

describe("invitation email delivery", () => {
  it("emails an owner's invitation and lets the invitee sign in by email and accept it", async () => {
    const transport = recordingEmailTransport();
    const { runtime } = await openRuntime(transport);
    const owner = await signIn(runtime, transport, "owner@example.test", "Olive Owner");
    const team = await post(runtime, "/api/teams", { name: "Falcons" }, owner.cookie);
    expect(team.status).toBe(201);
    const teamId = (JSON.parse(team.body) as { team: { id: string } }).team.id;

    const invited = await post(
      runtime,
      `/api/teams/${teamId}/invitations`,
      {
        invitedRole: "adult",
        inviteeLabel: "Assistant coach",
        recipientBinding: { kind: "verified_email", email: "helper@example.test" },
      },
      owner.cookie,
    );
    expect(invited.status).toBe(201);
    await runtime.outbox?.drain();

    const invitation = transport.messages.at(-1);
    expect(invitation?.to).toBe("helper@example.test");
    expect(invitation?.subject).toBe("Your Snackday team invitation");
    expect(invitation?.text).toContain('Team: "Falcons"');
    expect(invitation?.text).toContain('Invited by: "Olive Owner"');
    expect(invitation?.text).not.toContain("Assistant coach");
    const inviteToken = linkToken(invitation, "/invite");

    const signedOut = await post(runtime, "/api/invitations/accept", { token: inviteToken });
    expect(signedOut.status).toBe(401);
    const helper = await signIn(runtime, transport, "helper@example.test", "Hal Helper");
    const accepted = await post(
      runtime,
      "/api/invitations/accept",
      { token: inviteToken },
      helper.cookie,
    );
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({ team: { name: "Falcons" } });
    await runtime.close();
  });

  it("spends one daily send budget on creates and resends, per team and per inviter", async () => {
    const transport = recordingEmailTransport();
    const { runtime, advance } = await openRuntime(transport);
    const owner = await signIn(runtime, transport, "owner@example.test", "Olive Owner");
    const newTeam = async (name: string) => {
      const team = await post(runtime, "/api/teams", { name }, owner.cookie);
      return (JSON.parse(team.body) as { team: { id: string } }).team.id;
    };
    const invite = (teamId: string, label: string) =>
      post(
        runtime,
        `/api/teams/${teamId}/invitations`,
        {
          invitedRole: "adult",
          inviteeLabel: label,
          recipientBinding: { kind: "verified_email", email: "adult@example.test" },
        },
        owner.cookie,
      );
    // The kernel's real-time request limiter would answer 429 long before
    // 200 HTTP sends, so earlier sends in the window are written as outbox rows.
    const session = await runtime.app.handle("GET", "/api/session", {
      headers: { cookie: owner.cookie },
    });
    const ownerId = (JSON.parse(session.body) as { person: { id: string } }).person.id;
    const recordEarlierSends = async (invitationId: string, count: number, queuedBy: string) => {
      const at = new Date(START).toISOString();
      // One transaction: a commit per row is one disk sync per row, which
      // outran the 5 s test timeout on the CI runner's disk.
      await runtime.db.transaction(async (tx) => {
        for (let index = 0; index < count; index += 1) {
          await tx
            .insert(invitationOutbox)
            .values({
              id: `invitation_delivery_earlier_${invitationId}_${queuedBy}_${index}`,
              invitationId,
              deliveryKey: `earlier:${invitationId}:${queuedBy}:${index}`,
              tokenHash: "earlier",
              encryptedPayload: "earlier",
              status: "delivered",
              createdAt: at,
              updatedAt: at,
              queuedAt: at,
              deliveredAt: at,
              queuedByPersonId: queuedBy,
            })
            .run();
        }
      });
    };
    const createInvitation = async (teamId: string) => {
      const created = await invite(teamId, "Adult");
      expect(created.status).toBe(201);
      return (JSON.parse(created.body) as { invitation: { id: string } }).invitation.id;
    };
    const limitReached = { status: 429, body: '{"error":"invitation limit reached"}' };
    const spare = INVITATION_SENDS_PER_TEAM_PER_WINDOW - 1;

    const falcons = await newTeam("Falcons");
    const falconsInvitation = await createInvitation(falcons);
    await recordEarlierSends(falconsInvitation, spare, ownerId);
    const resendFalcons = () =>
      post(
        runtime,
        `/api/teams/${falcons}/invitations/${falconsInvitation}/resend`,
        {},
        owner.cookie,
      );
    expect(await resendFalcons()).toMatchObject(limitReached);
    expect(await invite(falcons, "Another adult")).toMatchObject(limitReached);

    const comets = await newTeam("Comets");
    await recordEarlierSends(await createInvitation(comets), spare, "person_someone_else");
    const owls = await newTeam("Owls");
    const owlsInvitation = await createInvitation(owls);

    const ownerSends = INVITATION_SENDS_PER_TEAM_PER_WINDOW + 2;
    await recordEarlierSends(
      owlsInvitation,
      INVITATION_SENDS_PER_PERSON_PER_WINDOW - ownerSends,
      ownerId,
    );
    expect(await invite(owls, "Another adult")).toMatchObject(limitReached);

    advance(24 * 60 * 60 * 1_000);
    expect((await resendFalcons()).status).toBe(200);
    const latest = await runtime.sql
      .prepare(
        "SELECT queued_by_person_id FROM invitation_delivery_outbox WHERE delivery_key NOT LIKE 'earlier:%' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    expect(latest).toEqual({ queued_by_person_id: ownerId });
    await runtime.close();
  });

  it("keeps invitation creation closed when no email provider is configured", async () => {
    const { runtime } = await openRuntime(NO_EMAIL_PROVIDER);

    const response = await post(runtime, "/api/teams/team_any/invitations", {
      invitedRole: "adult",
      inviteeLabel: "Anyone",
      recipientBinding: { kind: "verified_email", email: "anyone@example.test" },
    });

    expect(response.status).toBe(503);
    await runtime.close();
  });
});
