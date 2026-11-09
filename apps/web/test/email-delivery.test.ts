import { isPermanentFailure } from "@lesto/queue";
import { describe, expect, it } from "vitest";

import { recordingEmailTransport } from "../app/lib/server/email";
import { emailInviteDeliverer, quotedEmailName } from "../app/lib/server/invite-email";
import type { InviteDelivery } from "../app/lib/server/invite-delivery";
import { resendEmailTransport, TransientEmailError } from "../runtime/resend-email";

const message = {
  to: "coach@example.test",
  subject: "Subject",
  text: "Body with https://staging.snackduty.test/sign-in#secret",
  idempotencyKey: "sign-in:email_sign_in_1",
};

function respondingWith(status: number, body = "{}") {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("Resend email transport", () => {
  it("posts one message with the idempotency key and the configured sender", async () => {
    const { fetcher, requests } = respondingWith(200, '{"id":"email_1"}');
    const transport = resendEmailTransport({
      apiKey: "re_fixture",
      from: "Snackday <team@mail.snackduty.test>",
      fetch: fetcher,
    });

    await transport.send(message);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.resend.com/emails");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer re_fixture",
      "Idempotency-Key": "sign-in:email_sign_in_1",
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      from: "Snackday <team@mail.snackduty.test>",
      to: ["coach@example.test"],
      subject: "Subject",
      text: message.text,
    });
  });

  it("marks a request the provider will always reject as permanent", async () => {
    const { fetcher } = respondingWith(422, '{"message":"coach@example.test is invalid"}');
    const transport = resendEmailTransport({
      apiKey: "re_fixture",
      from: "a@b.test",
      fetch: fetcher,
    });

    const failure = await transport.send(message).catch((error: unknown) => error);

    expect(isPermanentFailure(failure)).toBe(true);
    expect(String(failure)).not.toContain("coach@example.test");
  });

  it("leaves rate limits, outages and network errors retryable", async () => {
    for (const status of [401, 429, 500, 503]) {
      const { fetcher } = respondingWith(status);
      const transport = resendEmailTransport({ apiKey: "k", from: "a@b.test", fetch: fetcher });
      const failure = await transport.send(message).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransientEmailError);
      expect(isPermanentFailure(failure)).toBe(false);
    }

    const offline = resendEmailTransport({
      apiKey: "k",
      from: "a@b.test",
      fetch: (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch,
    });
    const failure = await offline.send(message).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransientEmailError);
  });
});

describe("email invite deliverer", () => {
  const delivery: InviteDelivery = {
    idempotencyKey: "invitation:invitation_1:hash",
    invitationId: "invitation_1",
    teamName: "Falcons",
    inviterDisplayName: "Olive Owner",
    invitedRole: "adult",
    recipient: { kind: "confirmed_person", personId: "person_1" },
    inviteUrl: "/invite#token",
  };

  it("sends to every verified address of a confirmed person with a per-address key", async () => {
    const transport = recordingEmailTransport();
    const deliverer = emailInviteDeliverer({
      transport,
      publicBaseUrl: new URL("https://staging.snackduty.test"),
      recipientEmails: () => Promise.resolve(["a@example.test", "b@example.test"]),
    });

    await deliverer.deliver(delivery);
    await deliverer.deliver(delivery);

    expect(transport.messages.map((sent) => [sent.to, sent.idempotencyKey])).toEqual([
      ["a@example.test", "invitation:invitation_1:hash:a@example.test"],
      ["b@example.test", "invitation:invitation_1:hash:b@example.test"],
    ]);
    expect(transport.messages[0]?.text).toContain("https://staging.snackduty.test/invite#token");
    expect(deliverer.currentLink("invitation_1")).toBeUndefined();
  });

  it("keeps user-typed names on one quoted line with no live links", () => {
    expect(quotedEmailName("Falcons\r\nClick here: https://evil.example/login")).toBe(
      '"Falcons Click here: evil․example/login"',
    );
    expect(quotedEmailName("St. Mary's 10U")).toBe(`"St. Mary's 10U"`);
    expect(quotedEmailName("x".repeat(200))).toHaveLength(82);
  });

  it("fails permanently when the recipient has no verified address", async () => {
    const deliverer = emailInviteDeliverer({
      transport: recordingEmailTransport(),
      publicBaseUrl: new URL("https://staging.snackduty.test"),
      recipientEmails: () => Promise.resolve([]),
    });

    const failure = await deliverer.deliver(delivery).catch((error: unknown) => error);

    expect(isPermanentFailure(failure)).toBe(true);
  });
});
