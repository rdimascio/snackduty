import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

type AcceptState =
  | { readonly status: "idle" }
  | { readonly status: "accepting" }
  | { readonly status: "accepted"; readonly teamName: string; readonly grantedRole: string }
  | { readonly status: "failed" };

// `membership.role` is the role the server GRANTED — which is not always the
// role the invitation asked for (an owner who accepts a later adult invitation
// keeps `owner`). The invitation's own role is never rendered here: this note
// tells the person what they now hold.
interface AcceptResponse {
  membership: { role: string };
  team: { name: string };
}

function AcceptedNote({
  grantedRole,
  teamName,
}: {
  grantedRole: string;
  teamName: string;
}): ReactNode {
  return (
    <div>
      <p className="text-lg font-bold">You&apos;re on {teamName}!</p>
      <p className="mt-1 text-sm text-muted-foreground">
        You joined as {grantedRole === "owner" ? "an owner" : "an adult member"}.
      </p>
      <a className="mt-3 inline-block font-semibold text-primary" href="/app">
        Go to your team overview
      </a>
    </div>
  );
}

/**
 * The Accept button on the `/invite/<token>` landing page: POSTs the raw token
 * to the EXISTING accept endpoint — a same-origin fetch, so the app-wide
 * `originCheck` CSRF passes and the token travels in a request body, never a
 * query string an access log would keep. Success renders the team plus the
 * role the server actually GRANTED; every failure (404, 409, network) renders
 * the SAME generic message as the server-resolved invalid state — the page
 * never distinguishes why a link stopped working.
 */
function InviteAccept({ token }: { token: string }): ReactNode {
  const [state, setState] = useState<AcceptState>({ status: "idle" });

  async function accept(): Promise<void> {
    setState({ status: "accepting" });
    try {
      const response = await fetch("/api/invitations/accept", {
        body: JSON.stringify({ token }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setState({ status: "failed" });
        return;
      }
      const body = (await response.json()) as AcceptResponse;
      setState({
        grantedRole: body.membership.role,
        status: "accepted",
        teamName: body.team.name,
      });
    } catch {
      setState({ status: "failed" });
    }
  }

  if (state.status === "accepted") {
    return <AcceptedNote grantedRole={state.grantedRole} teamName={state.teamName} />;
  }

  if (state.status === "failed") {
    return (
      <p className="text-sm text-muted-foreground">
        This invite link isn&apos;t valid. Ask the person who invited you to send a fresh one.
      </p>
    );
  }

  return (
    <button
      className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={state.status === "accepting"}
      onClick={() => void accept()}
      type="button"
    >
      {state.status === "accepting" ? "Accepting…" : "Accept invitation"}
    </button>
  );
}

/**
 * The server-rendered shell until hydration swaps in the live component. NOT
 * `ssr: true`: under the `preact` client dialect the CLI's React server markup
 * would mismatch the Preact client on hydration (ASSETS_DIALECT_SSR_MISMATCH),
 * so the island defers — the same button, disabled until it can actually act.
 */
function AcceptFallback(): ReactNode {
  return (
    <button
      className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled
      type="button"
    >
      Accept invitation
    </button>
  );
}

export default defineIsland({
  component: InviteAccept,
  fallback: AcceptFallback,
  name: "InviteAccept",
});
