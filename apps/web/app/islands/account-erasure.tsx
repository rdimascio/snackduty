import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

import type { ManagedChild } from "../account/account-data";
import { inputClassName, labelClassName } from "../team/team-view";

const destructiveButtonClassName =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-destructive px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60";

const jsonPost = {
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  method: "POST",
} as const;

async function postJson(path: string, body: unknown): Promise<Response | undefined> {
  try {
    return await fetch(path, { ...jsonPost, body: JSON.stringify(body) });
  } catch {
    return undefined;
  }
}

function EraseChild({ child }: { child: ManagedChild }): ReactNode {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const response = await postJson(`/api/participants/${child.participantId}/erase`, {
      confirmName: typed,
    });
    if (response?.ok === true) {
      window.location.reload();
      return;
    }
    setPending(false);
    setFailure(
      response?.status === 422
        ? `Type ${child.name} exactly as shown.`
        : "We could not erase this data. Try again in a minute.",
    );
  }

  return (
    <form
      aria-label={`Erase ${child.name}`}
      className="grid gap-3 rounded-xl border border-border p-4"
      onSubmit={(event) => void submit(event)}
    >
      <p className="font-semibold">{child.name}</p>
      <p className="text-sm text-muted-foreground">
        This removes {child.name} from every team, with their birth date, attendance, RSVPs, lesson
        answers and skill ratings. Other guardians lose access too. It cannot be undone.
      </p>
      <label className={labelClassName}>
        Type {child.name} to confirm
        <input
          autoComplete="off"
          className={inputClassName}
          name="confirmName"
          onChange={(event) => setTyped(event.currentTarget.value)}
          required
          value={typed}
        />
      </label>
      {failure === undefined ? null : (
        <p className="text-sm font-semibold text-destructive" role="alert">
          {failure}
        </p>
      )}
      <button className={destructiveButtonClassName} disabled={pending} type="submit">
        {pending ? "Erasing…" : `Erase ${child.name}'s data`}
      </button>
    </form>
  );
}

interface BlockedResponse {
  soleOwnerTeams: { id: string; name: string }[];
  soleGuardianOf: { participantId: string }[];
}

function blockedReason(body: BlockedResponse): string {
  const reasons = [];
  if (body.soleOwnerTeams.length > 0) {
    const names = body.soleOwnerTeams.map((team) => team.name).join(", ");
    reasons.push(`you are the only owner of ${names}; add another owner or archive the team`);
  }
  if (body.soleGuardianOf.length > 0) {
    reasons.push("you are the only guardian of a child; erase that child's data first");
  }
  return `Your account was not erased: ${reasons.join(", and ")}.`;
}

function EraseAccount({ confirmation }: { confirmation: string }): ReactNode {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setFailure(undefined);
    const response = await postJson("/api/account/erase", { confirm: typed });
    if (response?.ok === true) {
      window.location.assign("/");
      return;
    }
    setPending(false);
    setFailure(
      response?.status === 409
        ? blockedReason((await response.json()) as BlockedResponse)
        : `Type "${confirmation}" exactly as shown.`,
    );
  }

  return (
    <form
      aria-label="Erase my account"
      className="grid gap-3 rounded-xl border border-border p-4"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-sm text-muted-foreground">
        This removes your name, email addresses, sign-in methods, calendar feeds and team access,
        and signs you out everywhere. Duties you claimed open up again. It cannot be undone.
      </p>
      <label className={labelClassName}>
        Type &quot;{confirmation}&quot; to confirm
        <input
          autoComplete="off"
          className={inputClassName}
          name="confirm"
          onChange={(event) => setTyped(event.currentTarget.value)}
          required
          value={typed}
        />
      </label>
      {failure === undefined ? null : (
        <p className="text-sm font-semibold text-destructive" role="alert">
          {failure}
        </p>
      )}
      <button className={destructiveButtonClassName} disabled={pending} type="submit">
        {pending ? "Erasing…" : "Erase my account"}
      </button>
    </form>
  );
}

/**
 * `confirmation` comes from the server page: importing it from the domain
 * package here would pull zod into the browser bundle, and zod compiles with
 * eval, which the Content-Security-Policy blocks.
 */
function AccountErasure({
  confirmation,
  managed,
}: {
  confirmation: string;
  managed: readonly ManagedChild[];
}): ReactNode {
  return (
    <div className="grid gap-10">
      <section aria-labelledby="children-heading" className="grid gap-4">
        <h2 className="text-xl font-bold" id="children-heading">
          Your children&apos;s data
        </h2>
        {managed.length === 0 ? (
          <p className="text-sm text-muted-foreground">You do not manage any child&apos;s data.</p>
        ) : (
          managed.map((child) => <EraseChild child={child} key={child.participantId} />)
        )}
      </section>
      <section aria-labelledby="account-heading" className="grid gap-4">
        <h2 className="text-xl font-bold" id="account-heading">
          Your account
        </h2>
        <EraseAccount confirmation={confirmation} />
      </section>
    </div>
  );
}

function AccountErasureFallback(): ReactNode {
  return (
    <p aria-live="polite" className="text-muted-foreground">
      Loading…
    </p>
  );
}

export default defineIsland({
  component: AccountErasure,
  fallback: AccountErasureFallback,
  name: "AccountErasure",
});
