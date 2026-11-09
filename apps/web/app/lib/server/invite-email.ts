import type { RecipientBinding } from "@snackday/domain";

import { PermanentEmailError } from "./email";
import type { EmailTransport } from "./email";
import type { InviteDeliverer, InviteDelivery } from "./invite-delivery";
import { INVITATION_TTL_MS } from "./invitations";

const INVITATION_TTL_DAYS = INVITATION_TTL_MS / (24 * 60 * 60 * 1_000);

export interface EmailInviteDelivererOptions {
  readonly transport: EmailTransport;
  /** The HTTPS origin the relative `/invite#<token>` link is resolved against. */
  readonly publicBaseUrl: URL;
  /** Every verified address the binding may be reached at, read at send time. */
  readonly recipientEmails: (recipient: RecipientBinding) => Promise<readonly string[]>;
}

function roleText(delivery: InviteDelivery): string {
  return delivery.invitedRole === "owner" ? "an owner" : "a member";
}

/**
 * Only the fields the privacy contract in `invite-delivery.ts` allows: the
 * team, the inviter, the role and the link. Never the invitee label.
 */
export function invitationEmailText(delivery: InviteDelivery, link: string): string {
  return [
    `${delivery.inviterDisplayName} invited you to join ${delivery.teamName} on Snackday as ${roleText(delivery)}.`,
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
          subject: `Join ${delivery.teamName} on Snackday`,
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
