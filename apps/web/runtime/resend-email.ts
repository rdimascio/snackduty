import { PermanentEmailError } from "../app/lib/server/email";
import type { EmailTransport } from "../app/lib/server/email";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** Statuses Resend keeps returning for the same request; retrying cannot help. */
const PERMANENT_REJECTION_STATUSES = new Set([400, 404, 405, 422]);

export interface ResendEmailOptions {
  readonly apiKey: string;
  /** A sender on a domain verified in Resend, e.g. `Snackday <team@mail.example>`. */
  readonly from: string;
  readonly fetch?: typeof fetch;
}

export class TransientEmailError extends Error {
  readonly code = "EMAIL_TRANSIENT_FAILURE";
}

/**
 * Sends through the Resend HTTP API. Errors carry only the HTTP status: a
 * response body can echo the recipient address, and a request never appears in
 * a thrown message.
 */
export function resendEmailTransport(options: ResendEmailOptions): EmailTransport {
  const send = options.fetch ?? fetch;

  return {
    async send(message) {
      let response: Response;
      try {
        response = await send(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
        });
      } catch {
        throw new TransientEmailError("Email provider request failed.");
      }
      await response.body?.cancel();
      if (response.ok) return;
      if (PERMANENT_REJECTION_STATUSES.has(response.status)) {
        throw new PermanentEmailError(`Email provider rejected the message (${response.status}).`);
      }
      throw new TransientEmailError(`Email provider is unavailable (${response.status}).`);
    },
  };
}
