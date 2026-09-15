import type { Db } from "@lesto/db";
import type {
  AttendanceInput,
  AttendanceReadResponse,
  AttendanceResponse,
  CreateEventInput,
  CreateEventResponse,
  DutySlotResponse,
  DutySlotsResponse,
  SeasonEventsResponse,
} from "@snackday/domain";
import type { Clock } from "./application-contracts";

// Supplied by a trusted session adapter, never request JSON. Each operation
// revalidates the exact active account/person pair within its transaction.
export interface ApplicationActor {
  readonly accountId: string;
  readonly personId: string;
}
export interface CoordinationServices {
  readonly db: Db;
  readonly clock: Clock;
}
export type CoordinationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 404 | 409 | 422;
      readonly body: { readonly error: string; readonly code: string };
    };
export interface SeasonTarget {
  readonly teamId: string;
  readonly seasonId: string;
}
export interface OccurrenceTarget {
  readonly teamId: string;
  readonly occurrenceId: string;
}
export interface CoordinationOperations {
  createEvent(
    actor: ApplicationActor,
    command: SeasonTarget & { readonly input: CreateEventInput },
  ): Promise<CoordinationResult<CreateEventResponse>>;
  listSeasonEvents(
    actor: ApplicationActor,
    target: SeasonTarget,
  ): Promise<CoordinationResult<SeasonEventsResponse>>;
  readAttendance(
    actor: ApplicationActor,
    target: OccurrenceTarget,
  ): Promise<CoordinationResult<AttendanceReadResponse>>;
  recordAttendance(
    actor: ApplicationActor,
    command: OccurrenceTarget & { readonly input: AttendanceInput },
  ): Promise<CoordinationResult<AttendanceResponse>>;
  listDutySlots(
    actor: ApplicationActor,
    target: OccurrenceTarget,
  ): Promise<CoordinationResult<DutySlotsResponse>>;
  claimDutySlot(
    actor: ApplicationActor,
    target: OccurrenceTarget & { readonly slotId: string },
  ): Promise<CoordinationResult<DutySlotResponse>>;
}
