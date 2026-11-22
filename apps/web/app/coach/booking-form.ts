import { z } from "zod";

import { LESSON_TYPE_IDS, PLAYER_AGE_MAX, PLAYER_AGE_MIN, playerAgeRange } from "./content";

export const BOOKING_FIELDS = [
  "parentName",
  "parentEmail",
  "phone",
  "playerAge",
  "lessonType",
  "city",
  "preferredTimes",
  "notes",
] as const;

export type BookingField = (typeof BOOKING_FIELDS)[number];

export type BookingValues = Readonly<Record<BookingField, string>>;

export type BookingErrors = Readonly<Partial<Record<BookingField, string>>>;

/** A real visitor never sees this field, so any value in it marks the post as automated. */
export const HONEYPOT_FIELD = "website";

export const BOOKING_FIELD_MAX_LENGTH: Readonly<Record<BookingField, number>> = {
  parentName: 80,
  parentEmail: 254,
  phone: 30,
  playerAge: 2,
  lessonType: 20,
  city: 60,
  preferredTimes: 120,
  notes: 500,
};

const PHONE_CHARACTERS = /^[0-9+().\- ]*$/u;

const AGE_DIGITS = /^[0-9]{1,2}$/u;

function tooLong(field: BookingField): string {
  return `Use ${BOOKING_FIELD_MAX_LENGTH[field]} characters or fewer.`;
}

function requiredText(field: BookingField, missing: string) {
  return z.string().trim().min(1, missing).max(BOOKING_FIELD_MAX_LENGTH[field], tooLong(field));
}

function optionalText(field: BookingField) {
  return z
    .string()
    .trim()
    .max(BOOKING_FIELD_MAX_LENGTH[field], tooLong(field))
    .transform((value) => (value === "" ? null : value));
}

const AGE_MESSAGE = `Enter an age from ${playerAgeRange}.`;

export const lessonRequestSchema = z.object({
  parentName: requiredText("parentName", "Enter your name."),
  parentEmail: z
    .string()
    .trim()
    .max(BOOKING_FIELD_MAX_LENGTH.parentEmail, tooLong("parentEmail"))
    .pipe(z.email("Enter an email address like name@example.com.")),
  phone: optionalText("phone").refine(
    (value) => value === null || PHONE_CHARACTERS.test(value),
    "Use only digits, spaces and + ( ) - in the phone number.",
  ),
  playerAge: z
    .string()
    .trim()
    .regex(AGE_DIGITS, AGE_MESSAGE)
    .transform(Number)
    .pipe(z.number().int().min(PLAYER_AGE_MIN, AGE_MESSAGE).max(PLAYER_AGE_MAX, AGE_MESSAGE)),
  lessonType: z.enum(LESSON_TYPE_IDS, "Choose a lesson type."),
  city: requiredText("city", "Enter your city."),
  preferredTimes: requiredText("preferredTimes", "Tell me which days and times work."),
  notes: optionalText("notes"),
});

export type LessonRequestInput = z.output<typeof lessonRequestSchema>;

export type BookingSubmission =
  | { readonly kind: "automated" }
  | { readonly kind: "invalid"; readonly values: BookingValues; readonly errors: BookingErrors }
  | { readonly kind: "valid"; readonly request: LessonRequestInput };

export const EMPTY_BOOKING_VALUES: BookingValues = {
  parentName: "",
  parentEmail: "",
  phone: "",
  playerAge: "",
  lessonType: "",
  city: "",
  preferredTimes: "",
  notes: "",
};

function formValues(form: URLSearchParams): BookingValues {
  const values: Partial<Record<BookingField, string>> = {};
  for (const field of BOOKING_FIELDS) {
    values[field] = (form.get(field) ?? "").slice(0, BOOKING_FIELD_MAX_LENGTH[field] + 1);
  }
  return { ...EMPTY_BOOKING_VALUES, ...values };
}

function isBookingField(value: unknown): value is BookingField {
  return typeof value === "string" && (BOOKING_FIELDS as readonly string[]).includes(value);
}

function firstErrorPerField(issues: readonly z.core.$ZodIssue[]): BookingErrors {
  const errors: Partial<Record<BookingField, string>> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (isBookingField(field) && errors[field] === undefined) errors[field] = issue.message;
  }
  return errors;
}

/** Reads an `application/x-www-form-urlencoded` body; anything else reads as an empty form. */
export function readBookingForm(body: unknown): BookingSubmission {
  const form = new URLSearchParams(typeof body === "string" ? body : "");
  if ((form.get(HONEYPOT_FIELD) ?? "") !== "") return { kind: "automated" };
  const values = formValues(form);
  const parsed = lessonRequestSchema.safeParse(values);
  if (parsed.success) return { kind: "valid", request: parsed.data };
  return { kind: "invalid", values, errors: firstErrorPerField(parsed.error.issues) };
}
