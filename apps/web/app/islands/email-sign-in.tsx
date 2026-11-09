import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

import { defineIsland } from "@lesto/ui";

import { EmptyState } from "../components/states/empty-state";
import { inputClassName, labelClassName, primaryButtonClassName } from "../team/team-view";

type SignInState =
  | { readonly status: "loading" }
  | { readonly status: "request" }
  | { readonly status: "sent"; readonly email: string }
  | { readonly status: "confirm"; readonly token: string; readonly maskedEmail: string }
  | { readonly status: "invalid" };

const jsonPost = {
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  method: "POST",
} as const;

const SIGN_IN_PATH = "/sign-in";
const SIGNED_IN_DESTINATION = "/app";

async function postJson(path: string, body: unknown): Promise<Response | undefined> {
  try {
    return await fetch(path, { ...jsonPost, body: JSON.stringify(body) });
  } catch {
    return undefined;
  }
}

async function previewToken(token: string): Promise<SignInState> {
  const response = await postJson("/api/auth/email/preview", { token });
  if (response?.ok !== true) return { status: "invalid" };
  const body = (await response.json()) as { maskedEmail: string };
  return { status: "confirm", token, maskedEmail: body.maskedEmail };
}

function RequestForm({ onSent }: { onSent: (email: string) => void }): ReactNode {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(undefined);
    setPending(true);
    const trimmedEmail = email.trim();
    const response = await postJson("/api/auth/email/start", { email: trimmedEmail });
    setPending(false);
    if (response?.ok === true) {
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
 * The link never signs anyone in by itself. The person holding it sees which
 * account it opens, gives adult consent and clicks. A link someone else sent
 * for their own account therefore cannot silently swap this browser's session.
 */
function ConfirmForm({
  maskedEmail,
  onInvalid,
  token,
}: {
  maskedEmail: string;
  onInvalid: () => void;
  token: string;
}): ReactNode {
  const [displayName, setDisplayName] = useState("");
  const [adult, setAdult] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    const name = displayName.trim();
    const response = await postJson("/api/auth/email/verify", {
      token,
      ...(name === "" ? {} : { displayName: name }),
      adultConsent: true,
    });
    if (response?.ok === true) {
      window.location.assign(SIGNED_IN_DESTINATION);
      return;
    }
    setPending(false);
    onInvalid();
  }

  return (
    <form
      aria-label="Confirm sign-in"
      className="mx-auto grid max-w-sm gap-4"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-center">
        Sign in as <strong>{maskedEmail}</strong>?
      </p>
      <p className="text-center text-sm text-muted-foreground">
        If this is not your email address, close this page.
      </p>
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
      <button className={primaryButtonClassName} disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/**
 * The sign-in link carries its token in the URL FRAGMENT, which no browser
 * sends to a server. The island reads it once, removes it from the address bar
 * and history, and sends it only in POST bodies. A link scanner that fetches
 * the URL therefore cannot use up the link.
 */
function EmailSignIn(): ReactNode {
  const [state, setState] = useState<SignInState>({ status: "loading" });
  const showSent = (email: string) => setState({ status: "sent", email });

  useEffect(() => {
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", SIGN_IN_PATH);
    if (token === "") {
      setState({ status: "request" });
      return;
    }
    void previewToken(token).then(setState);
  }, []);

  if (state.status === "loading") {
    return (
      <p aria-live="polite" className="text-center text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (state.status === "confirm") {
    return (
      <ConfirmForm
        maskedEmail={state.maskedEmail}
        onInvalid={() => setState({ status: "invalid" })}
        token={state.token}
      />
    );
  }
  if (state.status === "invalid") {
    return (
      <div className="grid gap-8">
        <EmptyState
          description="It may have been used already or expired. Ask for a new link below."
          title="This sign-in link is not valid"
        />
        <RequestForm onSent={showSent} />
      </div>
    );
  }
  if (state.status === "sent") {
    return (
      <EmptyState
        description={`If ${state.email} can receive email, a sign-in link is on its way.`}
        title="Check your email"
      />
    );
  }

  return <RequestForm onSent={showSent} />;
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
