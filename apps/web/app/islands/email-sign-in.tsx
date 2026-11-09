import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

import { defineIsland } from "@lesto/ui";

import { EmptyState } from "../components/states/empty-state";
import { inputClassName, labelClassName, primaryButtonClassName } from "../team/team-view";

type SignInState =
  | { readonly status: "loading" }
  | { readonly status: "form" }
  | { readonly status: "sent"; readonly email: string }
  | { readonly status: "verifying" }
  | { readonly status: "invalid" };

const jsonPost = {
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  method: "POST",
} as const;

const SIGN_IN_PATH = "/sign-in";
const SIGNED_IN_DESTINATION = "/app";

async function verifyToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/email/verify", {
      ...jsonPost,
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function requestLink(email: string, displayName: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/email/start", {
      ...jsonPost,
      body: JSON.stringify({
        email,
        ...(displayName === "" ? {} : { displayName }),
        adultConsent: true,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function SignInForm({ onSent }: { onSent: (email: string) => void }): ReactNode {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [adult, setAdult] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(undefined);
    setPending(true);
    const trimmedEmail = email.trim();
    const sent = await requestLink(trimmedEmail, displayName.trim());
    setPending(false);
    if (sent) {
      onSent(trimmedEmail);
      return;
    }
    setFailure("We could not send the email. Check the address and try again in a minute.");
  }

  return (
    <form
      aria-label="Sign in with email"
      className="mx-auto grid max-w-sm gap-4"
      onSubmit={(event) => void submit(event)}
    >
      <label className={labelClassName}>
        Email
        <input
          autoComplete="email"
          className={inputClassName}
          name="email"
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
          type="email"
          value={email}
        />
      </label>
      <label className={labelClassName}>
        Your name (first sign-in only)
        <input
          autoComplete="name"
          className={inputClassName}
          maxLength={200}
          name="displayName"
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          value={displayName}
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          checked={adult}
          className="mt-1"
          name="adultConsent"
          onChange={(event) => setAdult(event.currentTarget.checked)}
          required
          type="checkbox"
        />
        I am an adult (18 or older).
      </label>
      {failure === undefined ? null : (
        <p className="text-sm font-semibold text-destructive" role="alert">
          {failure}
        </p>
      )}
      <button className={primaryButtonClassName} disabled={pending} type="submit">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}

/**
 * The sign-in link carries its token in the URL FRAGMENT, which no browser
 * sends to a server. The island reads it once, removes it from the address bar
 * and history, and sends it only in a POST body. A link scanner that fetches
 * the URL therefore cannot use up the link.
 */
function EmailSignIn(): ReactNode {
  const [state, setState] = useState<SignInState>({ status: "loading" });

  useEffect(() => {
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", SIGN_IN_PATH);
    if (token === "") {
      setState({ status: "form" });
      return;
    }
    setState({ status: "verifying" });
    void verifyToken(token).then((ok) => {
      if (ok) {
        window.location.assign(SIGNED_IN_DESTINATION);
        return;
      }
      setState({ status: "invalid" });
    });
  }, []);

  if (state.status === "loading" || state.status === "verifying") {
    return (
      <p aria-live="polite" className="text-center text-muted-foreground">
        {state.status === "verifying" ? "Signing you in…" : "Loading…"}
      </p>
    );
  }
  if (state.status === "invalid") {
    return (
      <div className="grid gap-8">
        <EmptyState
          description="It may have been used already or expired. Ask for a new link below."
          title="This sign-in link is not valid"
        />
        <SignInForm onSent={(email) => setState({ status: "sent", email })} />
      </div>
    );
  }
  if (state.status === "sent") {
    return (
      <EmptyState
        description={`If ${state.email} can receive email, a sign-in link is on its way. Open it on this device.`}
        title="Check your email"
      />
    );
  }

  return <SignInForm onSent={(email) => setState({ status: "sent", email })} />;
}

function EmailSignInFallback(): ReactNode {
  return (
    <p aria-live="polite" className="text-center text-muted-foreground">
      Loading…
    </p>
  );
}

export default defineIsland({
  component: EmailSignIn,
  fallback: EmailSignInFallback,
  name: "EmailSignIn",
});
