import type { RecipientBinding } from "@snackday/domain";

import { PermanentEmailError } from "./email";
import type { EmailTransport } from "./email";
import type { InviteDeliverer, InviteDelivery } from "./invite-delivery";
import { INVITATION_TTL_MS } from "./invitations";

const INVITATION_TTL_DAYS = INVITATION_TTL_MS / (24 * 60 * 60 * 1_000);
export const INVITATION_EMAIL_SUBJECT = "Your Snackday team invitation";
const MAX_QUOTED_NAME_LENGTH = 80;
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** Characters a URL or address needs between scheme, user, host and path. */
const URL_SEPARATORS = /[:/\\@]/gu;
/** `.` and the code points UTS 46 maps to it: U+2024, U+3002, U+FF0E, U+FF61. */
const DOT_BETWEEN_WORDS = /(?<=[\p{L}\p{N}])[.․。．｡](?=[\p{L}\p{N}])/gu;

export interface EmailInviteDelivererOptions {
  readonly transport: EmailTransport;
  /** The HTTPS origin the relative `/invite#<token>` link is resolved against. */
  readonly publicBaseUrl: URL;
  /** Every verified address the binding may be reached at, read at send time. */
  readonly recipientEmails: (recipient: RecipientBinding) => Promise<readonly string[]>;
}

/**
 * Team and inviter names are typed by any signed-in adult. In an email they
 * stay on one line and lose every URL separator and every dot between words,
 * so a name cannot pose as instructions or as a second link.
 */
export function quotedEmailName(name: string): string {
  const neutral = name
    .replace(CONTROL_OR_LINE_BREAK, " ")
    .replace(URL_SEPARATORS, " ")
    .replace(DOT_BETWEEN_WORDS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const shortened =
    neutral.length > MAX_QUOTED_NAME_LENGTH
      ? `${neutral.slice(0, MAX_QUOTED_NAME_LENGTH - 1)}…`
      : neutral;
  return `"${shortened}"`;
}

function roleText(delivery: InviteDelivery): string {
  return delivery.invitedRole === "owner" ? "an owner" : "a member";
}

/**
 * Only the fields the privacy contract in `invite-delivery.ts` allows: the
 * team, the inviter, the role and the link. Never the invitee label. Fixed
 * copy comes first; user-typed names appear only in quotes.
 */
export function invitationEmailText(delivery: InviteDelivery, link: string): string {
  return [
    `You have an invitation to join a team on Snackday as ${roleText(delivery)}.`,
    "",
    `Team: ${quotedEmailName(delivery.teamName)}`,
    `Invited by: ${quotedEmailName(delivery.inviterDisplayName)}`,
    "",
    "Open this link to accept:",
    link,
    "",
    `The link works for ${INVITATION_TTL_DAYS} days and only for you.`,
    "If you did not expect this email, you can ignore it.",
  ].join("\n");
}

export function emailInviteDeliverer(options: EmailInviteDelivererOptions): InviteDeliverer {
  return {
    async deliver(delivery) {
      if (delivery.idempotencyKey === undefined) {
        throw new PermanentEmailError("Invitation email requires an idempotency key.");
      }
      const addresses = await options.recipientEmails(delivery.recipient);
      if (addresses.length === 0) {
        throw new PermanentEmailError("Invitation recipient has no verified email address.");
      }
      const link = new URL(delivery.inviteUrl, options.publicBaseUrl).toString();
      for (const address of addresses) {
        await options.transport.send({
          to: address,
          subject: INVITATION_EMAIL_SUBJECT,
          text: invitationEmailText(delivery, link),
          idempotencyKey: `${delivery.idempotencyKey}:${address}`,
        });
      }
    },

    currentLink() {
      return undefined;
    },
  };
}
