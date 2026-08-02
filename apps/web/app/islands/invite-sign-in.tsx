import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

/**
 * The signed-out affordance on the `/invite/<token>` landing page: the
 * development sign-in (POST `/api/dev/sign-in` with no body selects the
 * default persona) followed by a reload, so the server loader re-resolves the
 * invitation against the new session and swaps in the Accept button. A real
 * identity provider replaces the endpoint later; this island's shape stays.
 */
function InviteSignIn(): ReactNode {
  const [status, setStatus] = useState<"idle" | "signing-in" | "failed">("idle");

  async function signIn(): Promise<void> {
    setStatus("signing-in");
    try {
      const response = await fetch("/api/dev/sign-in", {
        credentials: "same-origin",
        method: "POST",
      });
      if (!response.ok) {
        setStatus("failed");
        return;
      }
      window.location.reload();
    } catch {
      setStatus("failed");
    }
  }

  if (status === "failed") {
    return (
      <p className="text-sm text-muted-foreground">
        Sign-in didn&apos;t work here. Open this link in the Snackday app instead.
      </p>
    );
  }

  return (
    <button
      className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={status === "signing-in"}
      onClick={() => void signIn()}
      type="button"
    >
      {status === "signing-in" ? "Signing in…" : "Sign in to accept"}
    </button>
  );
}

/**
 * The server-rendered shell until hydration swaps in the live component. NOT
 * `ssr: true`: under the `preact` client dialect the CLI's React server markup
 * would mismatch the Preact client on hydration (ASSETS_DIALECT_SSR_MISMATCH),
 * so the island defers — the same button, disabled until it can actually act.
 */
function SignInFallback(): ReactNode {
  return (
    <button
      className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled
      type="button"
    >
      Sign in to accept
    </button>
  );
}

export default defineIsland({
  component: InviteSignIn,
  fallback: SignInFallback,
  name: "InviteSignIn",
});
