import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

import { browserFetcher, createSeason } from "../team/team-actions";
import {
  inputClassName,
  labelClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from "../team/team-view";

type SeasonFormProps = {
  readonly teamId: string;
};

const fallbackTimeZone = "America/Los_Angeles";

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallbackTimeZone;
  } catch {
    return fallbackTimeZone;
  }
}

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function SeasonForm({ teamId }: SeasonFormProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!open) {
    return (
      <button className={secondaryButtonClassName} onClick={() => setOpen(true)} type="button">
        Create a season
      </button>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    if (endDate < startDate) {
      setError("The end date must not be before the start date.");
      return;
    }
    if (!isKnownTimeZone(timeZone.trim())) {
      setError("Enter a time zone such as America/Chicago.");
      return;
    }
    setPending(true);
    const result = await createSeason(browserFetcher, teamId, {
      label: label.trim(),
      startDate,
      endDate,
      timeZone: timeZone.trim(),
    });
    if (result.ok) {
      const query = new URLSearchParams({ team: teamId, season: result.value.seasonId });
      window.location.assign(`/app/team?${query.toString()}`);
      return;
    }
    setPending(false);
    setError(result.message);
  }

  return (
    <form
      aria-label="Create a season"
      className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      <label className={`${labelClassName} sm:col-span-2`}>
        Season name
        <input
          className={inputClassName}
          maxLength={80}
          name="label"
          onChange={(event) => setLabel(event.currentTarget.value)}
          placeholder="Spring 2027"
          required
          value={label}
        />
      </label>
      <label className={labelClassName}>
        Start date
        <input
          className={inputClassName}
          name="startDate"
          onChange={(event) => setStartDate(event.currentTarget.value)}
          required
          type="date"
          value={startDate}
        />
      </label>
      <label className={labelClassName}>
        End date
        <input
          className={inputClassName}
          min={startDate === "" ? undefined : startDate}
          name="endDate"
          onChange={(event) => setEndDate(event.currentTarget.value)}
          required
          type="date"
          value={endDate}
        />
      </label>
      <label className={`${labelClassName} sm:col-span-2`}>
        Time zone
        <input
          className={inputClassName}
          name="timeZone"
          onChange={(event) => setTimeZone(event.currentTarget.value)}
          required
          value={timeZone}
        />
      </label>
      {error === undefined ? null : (
        <p className="text-sm font-semibold text-destructive sm:col-span-2" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button className={primaryButtonClassName} disabled={pending} type="submit">
          {pending ? "Creating…" : "Create season"}
        </button>
        <button
          className={secondaryButtonClassName}
          disabled={pending}
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SeasonFormFallback(): ReactNode {
  return (
    <button className={secondaryButtonClassName} disabled type="button">
      Create a season
    </button>
  );
}

export default defineIsland({
  component: SeasonForm,
  fallback: SeasonFormFallback,
  name: "TeamSeasonForm",
});
