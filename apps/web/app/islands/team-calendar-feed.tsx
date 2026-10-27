import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

import { absoluteUrl, CopyField } from "../team/copy-field";
import { browserFetcher, createCalendarFeed, revokeCalendarFeed } from "../team/team-actions";
import {
  dangerButtonClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from "../team/team-view";

type CalendarFeedProps = {
  readonly teamId: string;
  readonly active: boolean;
};

function statusLine(active: boolean): string {
  return active
    ? "Your private feed link is active. Snackday shows a link only once, when you create it."
    : "You have no calendar feed for this team.";
}

function TeamCalendarFeed({ teamId, active: initial }: CalendarFeedProps): ReactNode {
  const [active, setActive] = useState(initial);
  const [link, setLink] = useState<string | undefined>();
  const [pending, setPending] = useState<"create" | "revoke" | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function create(): Promise<void> {
    setPending("create");
    setError(undefined);
    const result = await createCalendarFeed(browserFetcher, teamId);
    setPending(undefined);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setActive(true);
    setLink(absoluteUrl(result.value.path));
  }

  async function revoke(): Promise<void> {
    setPending("revoke");
    setError(undefined);
    const result = await revokeCalendarFeed(browserFetcher, teamId);
    setPending(undefined);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setActive(false);
    setLink(undefined);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm" role="status">
        {link === undefined ? statusLine(active) : "Your new feed link is ready. Copy it now."}
      </p>
      {link === undefined ? null : <CopyField label="Calendar feed link" value={link} />}
      {error === undefined ? null : (
        <p className="text-sm font-semibold text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className={active ? secondaryButtonClassName : primaryButtonClassName}
          disabled={pending !== undefined}
          onClick={() => void create()}
          type="button"
        >
          {pending === "create" ? "Creating…" : active ? "Create a new link" : "Create feed link"}
        </button>
        {active ? (
          <button
            className={dangerButtonClassName}
            disabled={pending !== undefined}
            onClick={() => void revoke()}
            type="button"
          >
            {pending === "revoke" ? "Revoking…" : "Revoke feed"}
          </button>
        ) : null}
      </div>
      {active ? (
        <p className="text-xs text-muted-foreground">
          A new link replaces the old one. The old link stops working.
        </p>
      ) : null}
    </div>
  );
}

function TeamCalendarFeedFallback({ active }: CalendarFeedProps): ReactNode {
  return (
    <p className="text-sm" role="status">
      {statusLine(active)}
    </p>
  );
}

export default defineIsland({
  component: TeamCalendarFeed,
  fallback: TeamCalendarFeedFallback,
  name: "TeamCalendarFeed",
});
