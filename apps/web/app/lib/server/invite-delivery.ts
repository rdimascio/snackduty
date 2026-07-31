/**
 * The invite-delivery PORT: how an invitation's link reaches the invited
 * adult. The development implementation below records the link in memory so
 * the API can hand back a copyable URL; a real provider (Resend or similar)
 * is a LATER adapter that implements the same interface and actually sends
 * email — nothing here should grow toward it beyond the seam itself.
 *
 * PRIVACY CONTRACT: the payload carries the team name, the inviter's display
 * name, the invited role, and the link — nothing else. Never the invitee
 * label (it may reference a child, e.g. "Maya's dad"), never participant
 * data, never person or account ids. Implementations must not log payloads.
 */

export type InvitedRole = "owner" | "adult";

export interface InviteDelivery {
  readonly invitationId: string;
  readonly teamName: string;
  readonly inviterDisplayName: string;
  readonly invitedRole: InvitedRole;
  readonly inviteUrl: string;
}

export interface InviteDeliverer {
  deliver(delivery: InviteDelivery): Promise<void>;
  /**
   * The most recently delivered link for an invitation, when the channel can
   * still retrieve it. The dev deliverer records links so pending invitations
   * can be listed with a copyable URL; an email adapter returns `undefined`
   * (a sent email is not retrievable) and the listing simply omits the link.
   */
  currentLink(invitationId: string): string | undefined;
}

export interface DevInviteDeliverer extends InviteDeliverer {
  /** Every payload delivered, in order — inspectable by tests and dev tooling. */
  readonly deliveries: readonly InviteDelivery[];
}

export function devInviteDeliverer(): DevInviteDeliverer {
  const deliveries: InviteDelivery[] = [];
  const linkByInvitationId = new Map<string, string>();

  return {
    deliveries,

    deliver(delivery) {
      deliveries.push(delivery);
      linkByInvitationId.set(delivery.invitationId, delivery.inviteUrl);
      return Promise.resolve();
    },

    currentLink(invitationId) {
      return linkByInvitationId.get(invitationId);
    },
  };
}
