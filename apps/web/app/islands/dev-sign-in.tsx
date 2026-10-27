import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

export interface DevSignInPersona {
  readonly key: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly can: string;
}

export type DevSignInProps = {
  readonly personas: readonly DevSignInPersona[];
  readonly currentPersonaKey?: string;
};

type SignInStatus =
  | { readonly state: "idle" }
  | { readonly state: "working"; readonly key: string }
  | { readonly state: "failed"; readonly key: string };

const SIGN_IN_FAILED = "Sign-in failed. Check that the seed ran, then try again.";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

export async function signInAsPersona(key: string): Promise<boolean> {
  const response = await fetch("/api/dev/sign-in", {
    body: JSON.stringify({ persona: key }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return response.ok;
}

function PersonaList({
  currentPersonaKey,
  disabled,
  onSignIn,
  personas,
  status,
}: DevSignInProps & {
  readonly disabled: boolean;
  readonly onSignIn?: (key: string) => void;
  readonly status: SignInStatus;
}): ReactNode {
  return (
    <ul aria-label="Seeded roles" className="grid gap-4">
      {personas.map((persona) => (
        <li
          className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
          key={persona.key}
        >
          <div className="flex flex-col gap-1">
            <p className="font-semibold">
              {persona.displayName}
              <span className="font-normal text-muted-foreground"> · {persona.role}</span>
            </p>
            <p className="text-sm text-muted-foreground">{persona.can}</p>
            <p className="text-xs text-muted-foreground">
              {persona.email} · persona <code>{persona.key}</code>
            </p>
            {status.state === "failed" && status.key === persona.key ? (
              <p className="text-sm text-destructive" role="alert">
                {SIGN_IN_FAILED}
              </p>
            ) : null}
          </div>
          <button
            aria-current={persona.key === currentPersonaKey ? "true" : undefined}
            className={buttonClass}
            data-persona={persona.key}
            disabled={disabled}
            onClick={onSignIn === undefined ? undefined : () => onSignIn(persona.key)}
            type="button"
          >
            {status.state === "working" && status.key === persona.key
              ? "Signing in…"
              : `Sign in as ${persona.displayName}`}
          </button>
        </li>
      ))}
    </ul>
  );
}

function DevSignIn(props: DevSignInProps): ReactNode {
  const [status, setStatus] = useState<SignInStatus>({ state: "idle" });

  const signIn = async (key: string) => {
    setStatus({ state: "working", key });
    const signedIn = await signInAsPersona(key).catch(() => false);
    if (signedIn) {
      window.location.assign("/app");
      return;
    }
    setStatus({ state: "failed", key });
  };

  return (
    <PersonaList
      {...props}
      disabled={status.state === "working"}
      onSignIn={(key) => void signIn(key)}
      status={status}
    />
  );
}

function DevSignInFallback(props: DevSignInProps): ReactNode {
  return <PersonaList {...props} disabled status={{ state: "idle" }} />;
}

export default defineIsland({
  component: DevSignIn,
  fallback: DevSignInFallback,
  name: "DevSignIn",
});
