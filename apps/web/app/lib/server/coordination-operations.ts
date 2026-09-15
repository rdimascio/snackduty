import type { CoordinationOperations, CoordinationServices } from "./coordination-contracts";
import { createAttendanceOperations } from "./attendance";
import { createDutyOperations } from "./duties";
import { createEventOperations } from "./events";

/** One application seam shared by HTTP today and native/background/tool callers later. */
export function createCoordinationOperations(
  services: CoordinationServices,
): CoordinationOperations {
  return {
    ...createEventOperations(services),
    ...createAttendanceOperations(services),
    ...createDutyOperations(services),
  };
}
