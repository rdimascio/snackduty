import type { Clock, SessionService as Sessions } from "./application-contracts";
import type { Db } from "@lesto/db";
import type { Context } from "@lesto/web";
export interface AppServices {
  readonly db: Db;
  readonly sessions: Sessions;
  readonly clock: Clock;
}
const servicesKey = "snackday.services";
export function bindAppServices(context: Context, services: AppServices): void {
  context.set(servicesKey, services);
}
export function appServices(context: Context): AppServices | undefined {
  return context.get<AppServices>(servicesKey);
}
