import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import {
  BOOKING_FIELD_MAX_LENGTH,
  EMPTY_BOOKING_VALUES,
  HONEYPOT_FIELD,
  readBookingForm,
} from "./booking-form";
import type { BookingErrors, BookingField } from "./booking-form";
import type { BookFormData, CoachBookingPages } from "./booking-pages";
import {
  COACH_BOOK_PATH,
  COACH_BOOK_RETRY_PATH,
  COACH_BOOK_SENT_PATH,
  coachTitle,
  lessonTypes,
  PLAYER_AGE_MAX,
  PLAYER_AGE_MIN,
  playerAgeRange,
} from "./content";

const UNPROCESSABLE_CONTENT = 422;

const emptyForm: BookFormData = { values: EMPTY_BOOKING_VALUES, errors: {} };

const inputClass =
  "mt-2 block w-full rounded-lg border border-line bg-transparent px-4 py-3 text-base text-chalk focus:border-clay focus:outline-none focus:ring-2 focus:ring-clay";

const labelClass = "block text-sm font-bold";

const hintClass = "mt-1 block text-sm text-muted";

const errorClass = "mt-2 block text-sm font-bold text-clay";

function errorId(field: BookingField): string {
  return `${field}-error`;
}

function FieldError({ field, errors }: { field: BookingField; errors: BookingErrors }): ReactNode {
  const message = errors[field];
  if (message === undefined) return null;
  return (
    <span className={errorClass} id={errorId(field)}>
      {message}
    </span>
  );
}

interface TextFieldProps {
  readonly field: BookingField;
  readonly label: string;
  readonly hint?: string;
  readonly type?: "text" | "email" | "tel" | "number";
  readonly autoComplete?: string;
  readonly required?: boolean;
  readonly form: BookFormData;
}

function describedBy(field: BookingField, hasHint: boolean, errors: BookingErrors) {
  const ids = [
    ...(hasHint ? [`${field}-hint`] : []),
    ...(errors[field] === undefined ? [] : [errorId(field)]),
  ];
  return ids.length === 0 ? undefined : ids.join(" ");
}

function TextField({
  field,
  label,
  hint,
  type = "text",
  autoComplete,
  required = true,
  form,
}: TextFieldProps): ReactNode {
  const invalid = form.errors[field] !== undefined;
  return (
    <div>
      <label className={labelClass} htmlFor={field}>
        {label}
        {required ? null : <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {hint === undefined ? null : (
        <span className={hintClass} id={`${field}-hint`}>
          {hint}
        </span>
      )}
      <input
        aria-describedby={describedBy(field, hint !== undefined, form.errors)}
        aria-invalid={invalid ? true : undefined}
        autoComplete={autoComplete}
        className={inputClass}
        defaultValue={form.values[field]}
        id={field}
        name={field}
        required={required}
        type={type}
        {...(type === "number"
          ? { min: PLAYER_AGE_MIN, max: PLAYER_AGE_MAX, inputMode: "numeric" as const }
          : { maxLength: BOOKING_FIELD_MAX_LENGTH[field] })}
      />
      <FieldError errors={form.errors} field={field} />
    </div>
  );
}

function LessonTypeField({ form }: { form: BookFormData }): ReactNode {
  const invalid = form.errors.lessonType !== undefined;
  return (
    <fieldset aria-describedby={invalid ? errorId("lessonType") : undefined}>
      <legend className={labelClass}>Lesson type</legend>
      <div className="mt-2 grid gap-3">
        {lessonTypes.map((lesson) => (
          <label
            className="flex items-start gap-3 rounded-lg border border-line p-4"
            htmlFor={`lessonType-${lesson.id}`}
            key={lesson.id}
          >
            <input
              className="mt-1 size-4 accent-clay"
              defaultChecked={form.values.lessonType === lesson.id}
              id={`lessonType-${lesson.id}`}
              name="lessonType"
              required
              type="radio"
              value={lesson.id}
            />
            <span>
              <span className="block font-bold">{lesson.name}</span>
              <span className="block text-sm text-muted">{lesson.who}</span>
            </span>
          </label>
        ))}
      </div>
      <FieldError errors={form.errors} field="lessonType" />
    </fieldset>
  );
}

function NotesField({ form }: { form: BookFormData }): ReactNode {
  return (
    <div>
      <label className={labelClass} htmlFor="notes">
        Notes <span className="font-normal text-muted">(optional)</span>
      </label>
      <span className={hintClass} id="notes-hint">
        What your player wants to work on. Please leave out the name of your player.
      </span>
      <textarea
        aria-describedby={describedBy("notes", true, form.errors)}
        aria-invalid={form.errors.notes === undefined ? undefined : true}
        className={inputClass}
        defaultValue={form.values.notes}
        id="notes"
        maxLength={BOOKING_FIELD_MAX_LENGTH.notes}
        name="notes"
        rows={4}
      />
      <FieldError errors={form.errors} field="notes" />
    </div>
  );
}

function Honeypot(): ReactNode {
  return (
    <div aria-hidden="true" hidden>
      <label htmlFor={HONEYPOT_FIELD}>Leave this field empty</label>
      <input
        autoComplete="off"
        id={HONEYPOT_FIELD}
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        type="text"
      />
    </div>
  );
}

function CoachShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh bg-field text-chalk" data-app-shell data-brand="coach">
      <main className="mx-auto max-w-2xl px-6 py-20 lg:px-10" id="main-content">
        <a className="text-sm font-bold tracking-[0.2em] text-clay uppercase" href="/">
          {coachTitle}
        </a>
        {children}
      </main>
    </div>
  );
}

function BookPage(form: BookFormData): ReactNode {
  const hasErrors = Object.keys(form.errors).length > 0;
  return (
    <CoachShell>
      <h1 className="mt-6 font-display text-5xl font-extrabold uppercase leading-[0.9] tracking-tight">
        Request a lesson
      </h1>
      <p className="mt-6 text-muted">
        Tell me a little about your player. I will reply by email to pick a time and send a pay
        link.
      </p>
      {hasErrors ? (
        <p className="mt-6 rounded-lg border border-clay p-4 font-bold" role="alert">
          Please fix the fields marked below.
        </p>
      ) : null}
      <form action={COACH_BOOK_PATH} className="mt-10 grid gap-8" method="post" noValidate>
        <TextField autoComplete="name" field="parentName" form={form} label="Your name" />
        <TextField
          autoComplete="email"
          field="parentEmail"
          form={form}
          label="Your email"
          type="email"
        />
        <TextField
          autoComplete="tel"
          field="phone"
          form={form}
          label="Phone"
          required={false}
          type="tel"
        />
        <TextField
          field="playerAge"
          form={form}
          hint={`Ages ${playerAgeRange}.`}
          label="Player age"
          type="number"
        />
        <LessonTypeField form={form} />
        <TextField autoComplete="address-level2" field="city" form={form} label="City" />
        <TextField
          field="preferredTimes"
          form={form}
          hint="For example: weekday evenings or Saturday mornings."
          label="Days and times that work"
        />
        <NotesField form={form} />
        <Honeypot />
        <button
          className="inline-flex min-h-11 items-center justify-center justify-self-start rounded-lg bg-clay px-6 py-2 text-sm font-bold tracking-[0.2em] text-ink uppercase transition-colors hover:bg-clay/90 focus:outline-none focus:ring-2 focus:ring-chalk"
          type="submit"
        >
          Send request
        </button>
      </form>
    </CoachShell>
  );
}

function SentPage(): ReactNode {
  return (
    <CoachShell>
      <h1 className="mt-6 font-display text-5xl font-extrabold uppercase leading-[0.9] tracking-tight">
        Request sent
      </h1>
      <p className="mt-6 text-muted">
        Thank you. I will reply by email, usually within two days, to pick a time and send a pay
        link.
      </p>
      <a
        className="mt-10 inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-6 py-2 text-sm font-bold tracking-[0.2em] uppercase"
        href="/"
      >
        Back to home
      </a>
    </CoachShell>
  );
}

const bookMetadata = () => ({
  title: `Request a lesson | ${coachTitle}`,
  description: "Request a private baseball lesson.",
  links: [{ rel: "canonical", href: COACH_BOOK_PATH }],
});

export const coachBook: PageDef<typeof COACH_BOOK_PATH, BookFormData> = {
  component: BookPage,
  load: () => emptyForm,
  metadata: bookMetadata,
};

export const coachBookRetry: PageDef<typeof COACH_BOOK_RETRY_PATH, BookFormData> = {
  component: BookPage,
  load: (c) => {
    c.status(UNPROCESSABLE_CONTENT);
    const submission = readBookingForm(c.req.body);
    return submission.kind === "invalid"
      ? { values: submission.values, errors: submission.errors }
      : emptyForm;
  },
  metadata: bookMetadata,
};

export const coachBookSent: PageDef<typeof COACH_BOOK_SENT_PATH> = {
  component: SentPage,
  metadata: () => ({ title: `Request sent | ${coachTitle}` }),
};

export const coachBookingPages: CoachBookingPages = {
  book: coachBook,
  bookSent: coachBookSent,
  bookRetry: coachBookRetry,
};
