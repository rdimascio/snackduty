import type { SqlDatabase, Dialect } from "@lesto/db";
import { secureStack } from "@lesto/kernel";
import { currentContext, fromRequestMiddleware } from "@lesto/web";
import type { Handler } from "@lesto/web";

export const BOOKING_POSTS_PER_WINDOW = 5;

export const BOOKING_WINDOW_MS = 10 * 60 * 1_000;

const MS_PER_SECOND = 1_000;

const BOOKING_KEY_PREFIX = "coach-booking:";

const UNKNOWN_CLIENT = "unknown-client";

/**
 * The client IP the transport resolved, the same identity the kernel's default
 * limiter keys on. The prefix keeps this bucket apart from the default one in
 * the shared rate-limit table.
 */
export function bookingClientKey(): string {
  return `${BOOKING_KEY_PREFIX}${currentContext()?.ip ?? UNKNOWN_CLIENT}`;
}

export interface BookingRateLimitOptions {
  readonly sql: SqlDatabase;
  readonly dialect?: Dialect;
}

/** A per-client limit on lesson request posts, kept in the app's SQL rate-limit store. */
export function bookingPostRateLimit(options: BookingRateLimitOptions): Handler {
  const [limit] = secureStack({
    rateLimit: {
      capacity: BOOKING_POSTS_PER_WINDOW,
      refillPerSecond: BOOKING_POSTS_PER_WINDOW / (BOOKING_WINDOW_MS / MS_PER_SECOND),
      keyFor: bookingClientKey,
    },
    db: options.sql,
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
  });
  if (limit === undefined) throw new Error("The booking rate limit did not build.");
  return fromRequestMiddleware(limit);
}
