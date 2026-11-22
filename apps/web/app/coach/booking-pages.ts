import type { PageDef } from "@lesto/web";

import type { BookingErrors, BookingValues } from "./booking-form";
import type { COACH_BOOK_PATH, COACH_BOOK_RETRY_PATH, COACH_BOOK_SENT_PATH } from "./content";
import type { LessonRequestOperations } from "./lesson-requests";

export interface BookFormData {
  readonly values: BookingValues;
  readonly errors: BookingErrors;
}

export interface CoachBookingPages {
  readonly book: PageDef<typeof COACH_BOOK_PATH, BookFormData>;
  readonly bookSent: PageDef<typeof COACH_BOOK_SENT_PATH>;
  readonly bookRetry: PageDef<typeof COACH_BOOK_RETRY_PATH, BookFormData>;
}

export interface CoachBookingPagesModule {
  readonly coachBookingPages: CoachBookingPages;
}

/** What the coach host needs to take lesson requests; without it the booking paths are a 404. */
export interface CoachBooking {
  readonly pages: CoachBookingPages;
  readonly requests: LessonRequestOperations;
}
