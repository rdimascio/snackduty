import type { InviteDeliverer } from "../app/lib/server/invite-delivery";

export class RuntimeAdapterUnavailableError extends Error {
  readonly code = "RUNTIME_ADAPTER_UNAVAILABLE";
}

/** Fails visibly until the persisted invitation outbox and real provider are integrated. */
export function unavailableInviteDeliverer(): InviteDeliverer {
  const unavailableLinks = new Map<string, string>();
  return {
    deliver() {
      return Promise.reject(
        new RuntimeAdapterUnavailableError("Invitation delivery is unavailable in this runtime."),
      );
    },

    currentLink(invitationId) {
      return unavailableLinks.get(invitationId);
    },
  };
}
