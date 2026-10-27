import type { ReactNode } from "react";
import { useState } from "react";

import { cancelOccurrence } from "./schedule-actions";
import type { ApiSender } from "./schedule-actions";

export type CancelOccurrenceProps = {
  readonly teamId: string;
  readonly occurrenceId: string;
  readonly eventTitle: string;
};

export function CancelOccurrence({
  teamId,
  occurrenceId,
  eventTitle,
  send,
  reload = () => window.location.reload(),
}: CancelOccurrenceProps & {
  readonly send?: ApiSender;
  readonly reload?: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  async function confirm(event: { preventDefault(): void }) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFailure(undefined);
    try {
      const result = await cancelOccurrence(teamId, occurrenceId, reason, send);
      if (result.ok) {
        reload();
        return;
      }
      setFailure(result.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-semibold text-destructive hover:bg-muted"
        onClick={() => setOpen(true)}
        type="button"
      >
        Cancel this date
      </button>
    );
  }

  return (
    <form
      aria-label={`Cancel ${eventTitle} on this date`}
      className="space-y-3"
      noValidate
      onSubmit={(event) => void confirm(event)}
    >
      <p className="text-sm text-muted-foreground">
        Only this date is cancelled. The rest of the series stays on the schedule, and families see
        the reason.
      </p>
      <label className="block text-sm font-semibold">
        Reason
        <textarea
          className="mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-base"
          disabled={saving}
          maxLength={500}
          name="reason"
          onChange={(event) => setReason(event.currentTarget.value)}
          rows={2}
          value={reason}
        />
      </label>
      {failure === undefined ? null : (
        <p className="text-sm font-semibold text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          disabled={saving}
          type="submit"
        >
          {saving ? "Cancelling…" : "Confirm cancellation"}
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setFailure(undefined);
          }}
          type="button"
        >
          Keep this date
        </button>
      </div>
    </form>
  );
}
