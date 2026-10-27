import type { ReactNode } from "react";
import { useRef, useState } from "react";

import { EVENT_KINDS, WEEKDAYS, weekdayOfDate } from "./format";
import type { EventKind, Weekday } from "./format";
import { buildEventInput, createEvent, updateSeries, withTimesChanged } from "./schedule-actions";
import type { ApiSender, EventFormField, EventFormValues } from "./schedule-actions";

export type EventFormProps = {
  readonly mode: "create" | "edit";
  readonly teamId: string;
  readonly seasonId: string;
  readonly seriesId?: string;
  readonly timeZone: string;
  readonly initial: EventFormValues;
  readonly cancelHref: string;
  readonly doneHref: string;
  readonly detailHrefPrefix: string;
};

const inputClass =
  "mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-base aria-invalid:border-destructive";
const labelClass = "block text-sm font-semibold";

function FieldError({ id, message }: { id: string; message: string | undefined }): ReactNode {
  if (message === undefined) return null;
  return (
    <p className="mt-1 text-sm font-semibold text-destructive" id={id}>
      {message}
    </p>
  );
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function EventForm({
  mode,
  teamId,
  seasonId,
  seriesId,
  timeZone,
  initial,
  cancelHref,
  doneHref,
  detailHrefPrefix,
  send,
  navigate = (href: string) => window.location.assign(href),
}: EventFormProps & {
  readonly send?: ApiSender;
  readonly navigate?: (href: string) => void;
}): ReactNode {
  const [values, setValues] = useState<EventFormValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<EventFormField, string>>>({});
  const [failure, setFailure] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const lastAttempt = useRef<{ key: string; requestId: string } | undefined>(undefined);

  function update<K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function updateTime<K extends "startTime" | "endTime" | "endsNextDay">(
    key: K,
    value: EventFormValues[K],
  ) {
    setValues((current) => ({ ...withTimesChanged(current), [key]: value }));
  }

  function setRepeat(repeat: "none" | "weekly") {
    setValues((current) => ({
      ...current,
      repeat,
      weekdays:
        repeat === "weekly" && current.weekdays.length === 0 && current.date !== ""
          ? [weekdayOfDate(current.date)]
          : current.weekdays,
    }));
  }

  function toggleWeekday(day: Weekday, checked: boolean) {
    setValues((current) => ({
      ...current,
      weekdays: checked
        ? WEEKDAYS.map((entry) => entry.value).filter(
            (value) => value === day || current.weekdays.includes(value),
          )
        : current.weekdays.filter((value) => value !== day),
    }));
  }

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (saving) return;
    const built = buildEventInput(values, timeZone, mode);
    if (!built.ok) {
      setErrors(built.errors);
      setFailure("Fix the highlighted fields, then save again.");
      return;
    }
    setErrors({});
    setFailure(undefined);
    setSaving(true);
    try {
      if (mode === "edit" && seriesId !== undefined) {
        const { snackDuty: _snack, ...seriesInput } = built.input;
        const result = await updateSeries(teamId, seriesId, seriesInput, send);
        if (result.ok) {
          navigate(doneHref);
          return;
        }
        setFailure(result.message);
        return;
      }
      const key = JSON.stringify(built.input);
      const requestId =
        lastAttempt.current?.key === key ? lastAttempt.current.requestId : newRequestId();
      lastAttempt.current = { key, requestId };
      const result = await createEvent(teamId, seasonId, built.input, requestId, send);
      if (result.ok) {
        navigate(
          result.value.firstOccurrenceId === undefined
            ? doneHref
            : `${detailHrefPrefix}${encodeURIComponent(result.value.firstOccurrenceId)}?team=${encodeURIComponent(teamId)}`,
        );
        return;
      }
      setFailure(result.message);
    } finally {
      setSaving(false);
    }
  }

  const weekly = values.repeat === "weekly";
  const invalid = (name: EventFormField) => (errors[name] === undefined ? undefined : true);
  const describedBy = (name: EventFormField) =>
    errors[name] === undefined ? undefined : `event-${name}-error`;

  return (
    <form
      aria-label={mode === "create" ? "Create event" : "Edit event series"}
      className="space-y-6"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <fieldset
        className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm"
        disabled={saving}
      >
        <legend className="px-1 text-lg font-bold">Event</legend>
        <label className={labelClass}>
          Title
          <input
            aria-describedby={describedBy("title")}
            aria-invalid={invalid("title")}
            autoComplete="off"
            className={inputClass}
            maxLength={200}
            name="title"
            onChange={(event) => update("title", event.currentTarget.value)}
            required
            type="text"
            value={values.title}
          />
        </label>
        <FieldError id="event-title-error" message={errors.title} />
        <label className={labelClass}>
          Type
          <select
            className={inputClass}
            name="kind"
            onChange={(event) => update("kind", event.currentTarget.value as EventKind)}
            value={values.kind}
          >
            {EVENT_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Location <span className="font-normal text-muted-foreground">(optional)</span>
          <input
            aria-describedby={describedBy("location")}
            aria-invalid={invalid("location")}
            className={inputClass}
            maxLength={200}
            name="location"
            onChange={(event) => update("location", event.currentTarget.value)}
            type="text"
            value={values.location}
          />
        </label>
        <FieldError id="event-location-error" message={errors.location} />
        <label className={labelClass}>
          Notes <span className="font-normal text-muted-foreground">(optional)</span>
          <textarea
            aria-describedby={describedBy("notes")}
            aria-invalid={invalid("notes")}
            className={inputClass}
            maxLength={2_000}
            name="notes"
            onChange={(event) => update("notes", event.currentTarget.value)}
            rows={3}
            value={values.notes}
          />
        </label>
        <FieldError id="event-notes-error" message={errors.notes} />
      </fieldset>

      <fieldset
        className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm"
        disabled={saving}
      >
        <legend className="px-1 text-lg font-bold">When</legend>
        <p className="text-sm text-muted-foreground">
          Times are in the team time zone, {timeZone}.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={labelClass}>
            {weekly ? "First date" : "Date"}
            <input
              aria-describedby={describedBy("date")}
              aria-invalid={invalid("date")}
              className={inputClass}
              name="date"
              onChange={(event) => update("date", event.currentTarget.value)}
              required
              type="date"
              value={values.date}
            />
          </label>
          <label className={labelClass}>
            Starts
            <input
              className={inputClass}
              name="startTime"
              onChange={(event) => updateTime("startTime", event.currentTarget.value)}
              required
              step={300}
              type="time"
              value={values.startTime}
            />
          </label>
          <label className={labelClass}>
            Ends
            <input
              aria-describedby={describedBy("endTime")}
              aria-invalid={invalid("endTime")}
              className={inputClass}
              name="endTime"
              onChange={(event) => updateTime("endTime", event.currentTarget.value)}
              required
              step={300}
              type="time"
              value={values.endTime}
            />
          </label>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
          <input
            checked={values.endsNextDay}
            name="endsNextDay"
            onChange={(event) => updateTime("endsNextDay", event.currentTarget.checked)}
            type="checkbox"
          />
          Ends the next day
        </label>
        <FieldError id="event-date-error" message={errors.date} />
        <FieldError id="event-endTime-error" message={errors.endTime} />
        <label className={labelClass}>
          Repeat
          <select
            className={inputClass}
            name="repeat"
            onChange={(event) =>
              setRepeat(event.currentTarget.value === "weekly" ? "weekly" : "none")
            }
            value={values.repeat}
          >
            <option value="none">Does not repeat</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        {weekly ? (
          <div className="space-y-4">
            <fieldset aria-describedby={describedBy("weekdays")}>
              <legend className={labelClass}>Repeat on</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {WEEKDAYS.map((day) => (
                  <label
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold has-checked:border-primary has-checked:bg-accent"
                    key={day.value}
                  >
                    <input
                      checked={values.weekdays.includes(day.value)}
                      name="weekdays"
                      onChange={(event) => toggleWeekday(day.value, event.currentTarget.checked)}
                      type="checkbox"
                      value={day.value}
                    />
                    <span aria-hidden="true">{day.short}</span>
                    <span className="sr-only">{day.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <FieldError id="event-weekdays-error" message={errors.weekdays} />
            <label className={labelClass}>
              Last date
              <input
                aria-describedby={describedBy("untilDate")}
                aria-invalid={invalid("untilDate")}
                className={inputClass}
                name="untilDate"
                onChange={(event) => update("untilDate", event.currentTarget.value)}
                required
                type="date"
                value={values.untilDate}
              />
            </label>
            <FieldError id="event-untilDate-error" message={errors.untilDate} />
          </div>
        ) : null}
        {mode === "edit" ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            Changes apply to every date in this series. A future date you remove is cancelled, not
            deleted. Past dates stay as they were.
          </p>
        ) : null}
      </fieldset>

      {mode === "create" ? (
        <fieldset
          className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm"
          disabled={saving}
        >
          <legend className="px-1 text-lg font-bold">Snack duty</legend>
          {weekly ? (
            <p className="text-sm text-muted-foreground">
              Snack duty can be added to a one-time event only. Families claim it on the Duties
              page.
            </p>
          ) : (
            <>
              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                <input
                  checked={values.snackDuty}
                  name="snackDuty"
                  onChange={(event) => update("snackDuty", event.currentTarget.checked)}
                  type="checkbox"
                />
                Add a snack duty for families to claim
              </label>
              {values.snackDuty ? (
                <>
                  <label className={labelClass}>
                    Duty name
                    <input
                      aria-describedby={describedBy("snackLabel")}
                      aria-invalid={invalid("snackLabel")}
                      className={inputClass}
                      maxLength={120}
                      name="snackLabel"
                      onChange={(event) => update("snackLabel", event.currentTarget.value)}
                      type="text"
                      value={values.snackLabel}
                    />
                  </label>
                  <FieldError id="event-snackLabel-error" message={errors.snackLabel} />
                  <label className={labelClass}>
                    Instructions{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                    <textarea
                      aria-describedby={describedBy("snackInstructions")}
                      aria-invalid={invalid("snackInstructions")}
                      className={inputClass}
                      maxLength={2_000}
                      name="snackInstructions"
                      onChange={(event) => update("snackInstructions", event.currentTarget.value)}
                      rows={2}
                      value={values.snackInstructions}
                    />
                  </label>
                  <FieldError
                    id="event-snackInstructions-error"
                    message={errors.snackInstructions}
                  />
                </>
              ) : null}
            </>
          )}
        </fieldset>
      ) : null}

      {failure === undefined ? null : (
        <p
          className="rounded-lg border border-destructive p-3 text-sm font-semibold text-destructive"
          role="alert"
        >
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
          disabled={saving}
          type="submit"
        >
          {saving ? "Saving…" : mode === "create" ? "Create event" : "Save series"}
        </button>
        <a
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-5 py-2 text-sm font-semibold shadow-sm hover:bg-muted"
          href={cancelHref}
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
