import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

import type { SeedPersonaKey } from "../dev/seed-personas";

export type BallplayerSessionAction = "sign-in" | "sign-out";

export type BallplayerSessionProps = {
  readonly action: BallplayerSessionAction;
};

type Persona = Extract<SeedPersonaKey, "parent" | "head-coach" | "co-coach">;

type SessionStatus =
  | { readonly state: "idle" }
  | { readonly state: "working" }
  | { readonly state: "unavailable" }
  | { readonly state: "failed" };

export const BALLPLAYER_DEV_PERSONAS: readonly {
  readonly persona: Persona;
  readonly label: string;
}[] = [
  { persona: "parent", label: "Sign in as Pat Parent (guardian)" },
  { persona: "head-coach", label: "Sign in as Hana Headcoach (head coach)" },
  { persona: "co-coach", label: "Sign in as Cole Cocoach (co-coach)" },
];

const jsonPost = {
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  method: "POST",
} as const;

const buttonClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const primaryClass = `${buttonClass} bg-clay text-ink hover:bg-clay/90`;

const secondaryClass = `${buttonClass} border border-line text-chalk hover:bg-white/5`;

const SIGN_IN_UNAVAILABLE = "Web sign-in is not available on this server yet.";

const SIGN_IN_FAILED = "Sign-in failed. Try again.";

const SIGN_OUT_FAILED = "Sign-out failed. Try again.";

export async function signInAs(persona: Persona): Promise<SessionStatus> {
  const response = await fetch("/api/dev/sign-in", {
    ...jsonPost,
    body: JSON.stringify({ persona }),
  });
  if (response.ok) return { state: "working" };
  return response.status === 404 ? { state: "unavailable" } : { state: "failed" };
}

export async function signOut(): Promise<SessionStatus> {
  const response = await fetch("/api/session/logout", jsonPost);
  return response.ok ? { state: "working" } : { state: "failed" };
}

function StatusLine({ status, failure }: { status: SessionStatus; failure: string }): ReactNode {
  if (status.state === "unavailable") {
    return (
      <p className="text-sm text-muted" role="status">
        {SIGN_IN_UNAVAILABLE}
      </p>
    );
  }
  if (status.state === "failed") {
    return (
      <p className="text-sm text-clay" role="alert">
        {failure}
      </p>
    );
  }
  return null;
}

function SignInButtons({
  disabled,
  onSignIn,
  status,
}: {
  disabled: boolean;
  onSignIn?: (persona: Persona) => void;
  status: SessionStatus;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {BALLPLAYER_DEV_PERSONAS.map(({ persona, label }, index) => (
        <button
          className={index === 0 ? primaryClass : secondaryClass}
          disabled={disabled}
          key={persona}
          onClick={onSignIn === undefined ? undefined : () => onSignIn(persona)}
          type="button"
        >
          {status.state === "working" && index === 0 ? "Signing in…" : label}
        </button>
      ))}
      <StatusLine failure={SIGN_IN_FAILED} status={status} />
    </div>
  );
}

function SignOutButton({
  disabled,
  onSignOut,
  status,
}: {
  disabled: boolean;
  onSignOut?: () => void;
  status: SessionStatus;
}): ReactNode {
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className={`${secondaryClass} w-auto`}
        disabled={disabled}
        onClick={onSignOut}
        type="button"
      >
        {status.state === "working" ? "Signing out…" : "Sign out"}
      </button>
      <StatusLine failure={SIGN_OUT_FAILED} status={status} />
    </div>
  );
}

function BallplayerSession({ action }: BallplayerSessionProps): ReactNode {
  const [status, setStatus] = useState<SessionStatus>({ state: "idle" });
  const busy = status.state === "working";

  const run = async (attempt: () => Promise<SessionStatus>, next: string) => {
    setStatus({ state: "working" });
    const outcome = await attempt().catch((): SessionStatus => ({ state: "failed" }));
    setStatus(outcome);
    if (outcome.state === "working") window.location.assign(next);
  };

  if (action === "sign-out") {
    return (
      <SignOutButton disabled={busy} onSignOut={() => void run(signOut, "/")} status={status} />
    );
  }
  return (
    <SignInButtons
      disabled={busy || status.state === "unavailable"}
      onSignIn={(persona) => void run(() => signInAs(persona), "/app")}
      status={status}
    />
  );
}

function BallplayerSessionFallback({ action }: BallplayerSessionProps): ReactNode {
  const idle: SessionStatus = { state: "idle" };
  return action === "sign-out" ? (
    <SignOutButton disabled status={idle} />
  ) : (
    <SignInButtons disabled status={idle} />
  );
}

export default defineIsland({
  component: BallplayerSession,
  fallback: BallplayerSessionFallback,
  name: "BallplayerSession",
});
