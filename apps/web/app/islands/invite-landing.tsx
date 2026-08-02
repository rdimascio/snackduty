import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { defineIsland } from "@lesto/ui";

import { EmptyState } from "../components/states/empty-state";

/**
 * What the invitation resolved to. Every one of these is decided IN THE
 * BROWSER, because the credential that decides them never reaches the server as
 * part of a URL — see `lib/server/invitations.ts`'s `inviteUrlFor`.
 */
type Landing =
  | { readonly status: "resolving" }
  | { readonly status: "no-token" }
  | {
      readonly status: "preview";
      readonly teamName: string;
      readonly inviterDisplayName: string;
      readonly invitedRole: string;
    }
  | { readonly status: "accepted"; readonly teamName: string; readonly grantedRole: string }
  | { readonly status: "invalid" };

/** The two 200 shapes `POST /api/invitations/preview` answers with. */
type PreviewResponse =
  | { state: "preview"; teamName: string; inviterDisplayName: string; invitedRole: string }
  | { state: "accepted"; teamName: string; grantedRole: string };

// `membership.role` is the role the server GRANTED — which is not always the
// role the invitation asked for (an owner who accepts a later adult invitation
// keeps `owner`). The invitation's own role is never rendered: what the person
// now holds is.
interface AcceptResponse {
  membership: { role: string };
  team: { name: string };
}

function roleDescription(role: string): string {
  return role === "owner" ? "an owner" : "an adult member";
}

const jsonPost = {
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  method: "POST",
} as const;

/**
 * Resolve the token against the preview endpoint. Every failure — 404, 500,
 * offline — becomes the SAME generic invalid state: the page never distinguishes
 * why a link stopped working, mirroring the endpoint's own hiding 404.
 */
async function resolveToken(token: string): Promise<Landing> {
  try {
    const response = await fetch("/api/invitations/preview", {
      ...jsonPost,
      body: JSON.stringify({ token }),
    });
    if (!response.ok) return { status: "invalid" };
    const body = (await response.json()) as PreviewResponse;

    return body.state === "accepted"
      ? { status: "accepted", teamName: body.teamName, grantedRole: body.grantedRole }
      : {
          status: "preview",
          teamName: body.teamName,
          inviterDisplayName: body.inviterDisplayName,
          invitedRole: body.invitedRole,
        };
  } catch {
    return { status: "invalid" };
  }
}

function Resolving(): ReactNode {
  return (
    <p aria-live="polite" className="text-center text-muted-foreground">
      Checking your invitation…
    </p>
  );
}

function Invalid(): ReactNode {
  return (
    <EmptyState
      description="It may have been used, replaced, or expired. Ask the person who invited you to send a fresh link."
      title="This invite link isn't valid"
    />
  );
}

/**
 * The FRAGMENT-STRIPPED state, and the reason the empty fragment is handled
 * separately at all: some mail clients and link scanners rewrite a URL and drop
 * everything after the `#`. That would otherwise look exactly like a dead link,
 * with nobody able to tell the difference. Naming it makes the failure
 * observable — and recoverable, because a resend mints a fresh link.
 */
function NoToken(): ReactNode {
  return (
    <EmptyState
      description="Some email apps trim the end of a link. Ask the person who invited you to send a fresh one, and open it directly."
      title="This link didn't carry its code"
    />
  );
}

function Accepted({ grantedRole, teamName }: { grantedRole: string; teamName: string }): ReactNode {
  return (
    <div className="text-center">
      <p className="text-sm font-bold text-primary">Invitation accepted</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
        You&apos;re on {teamName}
      </h1>
      <p className="mt-2 text-muted-foreground">You joined as {roleDescription(grantedRole)}.</p>
      <div className="mt-8">
        <a
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          href="/app"
        >
          Go to your team overview
        </a>
      </div>
    </div>
  );
}

const actionClassName =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The whole client-resolved invitation landing.
 *
 * The credential arrives in the URL FRAGMENT, which the browser never sends to
 * any server. This island reads it once, immediately replaces the history entry
 * with a bare `/invite` so the token leaves the URL bar (and anything that later
 * reads `document.URL`, `location.href`, or a `Referer`), and thereafter passes
 * it only in POST request bodies. It lives in ONE island rather than three
 * because the token is state, not a prop: a server loader cannot see it, and an
 * island that re-entered through a page reload would find the fragment already
 * gone. That is also why signing in re-resolves in place instead of reloading.
 *
 * `signedIn` is the only thing the server loader could still resolve, and it
 * chooses which affordance a valid preview offers.
 */
function InviteLanding({ signedIn: sessionAtLoad }: { signedIn: boolean }): ReactNode {
  const [token, setToken] = useState("");
  const [signedIn, setSignedIn] = useState(sessionAtLoad);
  const [landing, setLanding] = useState<Landing>({ status: "resolving" });
  const [pending, setPending] = useState<"idle" | "accepting" | "signing-in">("idle");
  const [signInFailed, setSignInFailed] = useState(false);

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    // FIRST, before any await: the credential leaves the URL bar and this
    // history entry. A back button, a screenshot, a shared tab, and a later
    // `Referer` all see `/invite` and nothing else.
    window.history.replaceState(null, "", "/invite");

    if (fragment === "") {
      setLanding({ status: "no-token" });
      return;
    }
    setToken(fragment);
    void resolveToken(fragment).then(setLanding);
  }, []);

  async function accept(): Promise<void> {
    setPending("accepting");
    try {
      const response = await fetch("/api/invitations/accept", {
        ...jsonPost,
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setLanding({ status: "invalid" });
        return;
      }
      const body = (await response.json()) as AcceptResponse;
      setLanding({
        status: "accepted",
        teamName: body.team.name,
        grantedRole: body.membership.role,
      });
    } catch {
      setLanding({ status: "invalid" });
    } finally {
      setPending("idle");
    }
  }

  async function signIn(): Promise<void> {
    setPending("signing-in");
    setSignInFailed(false);
    try {
      const response = await fetch("/api/dev/sign-in", {
        credentials: "same-origin",
        method: "POST",
      });
      if (!response.ok) {
        setSignInFailed(true);
        return;
      }
      // NOT a reload: the fragment is already gone from the URL, so a reload
      // would land on a bare `/invite` and lose the invitation. The token is
      // still in memory, so re-resolve it against the new session instead.
      setSignedIn(true);
      setLanding(await resolveToken(token));
    } catch {
      setSignInFailed(true);
    } finally {
      setPending("idle");
    }
  }

  /** What a valid preview offers: accept it, or get a session that can. */
  function affordance(): ReactNode {
    if (signedIn) {
      return (
        <button
          className={actionClassName}
          disabled={pending === "accepting"}
          onClick={() => void accept()}
          type="button"
        >
          {pending === "accepting" ? "Accepting…" : "Accept invitation"}
        </button>
      );
    }
    if (signInFailed) {
      return (
        <p className="text-sm text-muted-foreground">
          Sign-in didn&apos;t work here. Open this link in the Snackday app instead.
        </p>
      );
    }

    return (
      <>
        <p className="text-sm text-muted-foreground">Sign in to accept this invitation.</p>
        <button
          className={actionClassName}
          disabled={pending === "signing-in"}
          onClick={() => void signIn()}
          type="button"
        >
          {pending === "signing-in" ? "Signing in…" : "Sign in to accept"}
        </button>
      </>
    );
  }

  if (landing.status === "resolving") return <Resolving />;
  if (landing.status === "no-token") return <NoToken />;
  if (landing.status === "invalid") return <Invalid />;
  if (landing.status === "accepted") {
    return <Accepted grantedRole={landing.grantedRole} teamName={landing.teamName} />;
  }

  return (
    <div className="text-center">
      <p className="text-sm font-bold text-primary">You&apos;re invited</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{landing.teamName}</h1>
      <p className="mt-2 text-muted-foreground">
        {landing.inviterDisplayName} invited you to join as {roleDescription(landing.invitedRole)}.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">{affordance()}</div>
    </div>
  );
}

/**
 * The server-rendered shell until hydration swaps in the live component. NOT
 * `ssr: true`: the server cannot resolve ANY of this island's states (it never
 * receives the fragment that decides them), and under the `preact` client
 * dialect the CLI's React server markup would mismatch on hydration
 * (ASSETS_DIALECT_SSR_MISMATCH) besides. The shell is the same calm line the
 * live component shows while it resolves.
 */
function LandingFallback(): ReactNode {
  return <Resolving />;
}

export default defineIsland({
  component: InviteLanding,
  fallback: LandingFallback,
  name: "InviteLanding",
});
