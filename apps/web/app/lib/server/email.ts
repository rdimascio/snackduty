/**
 * The email PORT shared by invitation delivery and email sign-in links. A
 * transport sends one plain-text message; it never logs the message, because
 * the body carries a live bearer link.
 */

import { PERMANENT_FAILURE } from "@lesto/queue";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Forwarded to the provider so a retried send never delivers twice. */
  readonly idempotencyKey: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/**
 * A provider rejection that no retry can fix (bad address, bad request). It
 * carries the `@lesto/queue` permanent-failure flag, so an outbox job that
 * throws it retires at once instead of burning its remaining attempts.
 */
export class PermanentEmailError extends Error {
  readonly code = "EMAIL_PERMANENT_FAILURE";
  readonly [PERMANENT_FAILURE] = true as const;
}

export interface RecordingEmailTransport extends EmailTransport {
  /** Every message sent, in order — inspectable by tests and dev tooling. */
  readonly messages: readonly EmailMessage[];
}

/** Records messages in memory and honors idempotency keys like a real provider. */
export function recordingEmailTransport(): RecordingEmailTransport {
  const messages: EmailMessage[] = [];
  const sentKeys = new Set<string>();

  return {
    messages,
    send(message) {
      if (sentKeys.has(message.idempotencyKey)) return Promise.resolve();
      sentKeys.add(message.idempotencyKey);
      messages.push(message);
      return Promise.resolve();
    },
  };
}
