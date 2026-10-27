import type { ReactNode } from "react";
import { useState } from "react";

import { ATTENDANCE_CHOICES, attendanceLabel, countsSummary } from "./format";
import type { AttendanceStatus } from "./format";
import { recordAttendance } from "./schedule-actions";
import type { ApiSender, AttendanceView } from "./schedule-actions";

export type AttendancePanelProps = {
  readonly teamId: string;
  readonly occurrenceId: string;
  readonly cancelled: boolean;
  readonly canManage: boolean;
  readonly attendance: AttendanceView;
};

interface SummaryGroup {
  readonly label: string;
  readonly names: readonly string[];
}

export function attendanceSummary(attendance: AttendanceView): SummaryGroup[] {
  const statusById = new Map<string, { name: string; status: AttendanceStatus | undefined }>();
  for (const option of attendance.responseOptions) {
    statusById.set(option.participantId, { name: option.displayName, status: option.status });
  }
  for (const entry of attendance.entries) {
    statusById.set(entry.participantId, { name: entry.displayName, status: entry.status });
  }
  const people = [...statusById.values()];
  const named = (status: AttendanceStatus | undefined) =>
    people
      .filter((person) => person.status === status)
      .map((person) => person.name)
      .sort((left, right) => left.localeCompare(right));
  return [
    ...ATTENDANCE_CHOICES.map((choice) => ({ label: choice.label, names: named(choice.value) })),
    { label: "No response", names: named(undefined) },
  ];
}

function CoachSummary({ attendance }: { attendance: AttendanceView }): ReactNode {
  return (
    <section
      aria-labelledby="attendance-summary-title"
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="text-lg font-bold" id="attendance-summary-title">
        Attendance summary
      </h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {attendanceSummary(attendance).map((group) => (
          <div className="rounded-xl bg-muted p-3" key={group.label}>
            <dt className="text-sm font-bold">
              {group.label}{" "}
              <span className="font-normal text-muted-foreground">({group.names.length})</span>
            </dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              {group.names.length === 0 ? "Nobody" : group.names.join(", ")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AttendancePanel({
  teamId,
  occurrenceId,
  cancelled,
  canManage,
  attendance: initial,
  send,
}: AttendancePanelProps & { readonly send?: ApiSender }): ReactNode {
  const [attendance, setAttendance] = useState<AttendanceView>(initial);
  const [pending, setPending] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  async function choose(participantId: string, displayName: string, status: AttendanceStatus) {
    setPending(participantId);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const result = await recordAttendance(teamId, occurrenceId, participantId, status, send);
      if (result.ok) {
        setAttendance(result.value);
        setNotice(`Saved: ${displayName} is ${attendanceLabel(status).toLowerCase()}.`);
      } else {
        setFailure(result.message);
      }
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="rsvp-title"
        className="rounded-2xl border border-border bg-card p-5 shadow-sm"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold" id="rsvp-title">
            {canManage ? "Take attendance" : "RSVP for your players"}
          </h2>
          <p className="text-sm text-muted-foreground">{countsSummary(attendance.counts)}</p>
        </div>
        {attendance.responseOptions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No RSVP choices are available for this account. A guardian answers for their own
            players.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {attendance.responseOptions.map((option) => (
              <li
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                key={option.participantId}
              >
                <p className="min-w-0">
                  <span className="font-semibold">{option.displayName}</span>{" "}
                  <span className="text-sm text-muted-foreground">
                    · {attendanceLabel(option.status)}
                  </span>
                </p>
                <div
                  aria-label={`RSVP for ${option.displayName}`}
                  className="flex flex-wrap gap-2"
                  role="group"
                >
                  {ATTENDANCE_CHOICES.map((choice) => (
                    <button
                      aria-pressed={option.status === choice.value}
                      className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-60 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                      disabled={cancelled || pending !== undefined}
                      key={choice.value}
                      onClick={() =>
                        void choose(option.participantId, option.displayName, choice.value)
                      }
                      type="button"
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {cancelled ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Cancelled events cannot accept RSVP changes.
          </p>
        ) : null}
        {pending === undefined ? null : (
          <p className="mt-3 text-sm text-muted-foreground" role="status">
            Saving…
          </p>
        )}
        {notice === undefined ? null : (
          <p className="mt-3 text-sm font-semibold text-primary" role="status">
            {notice}
          </p>
        )}
        {failure === undefined ? null : (
          <p className="mt-3 text-sm font-semibold text-destructive" role="alert">
            {failure}
          </p>
        )}
      </section>
      {canManage ? <CoachSummary attendance={attendance} /> : null}
    </div>
  );
}
