import type { App } from "@lesto/kernel";
import type { LestoResponse } from "@lesto/web";

const notFound: LestoResponse = {
  status: 404,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ error: "not found" }),
};

const invitationDeliveryUnavailable: LestoResponse = {
  status: 503,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": "300",
  },
  body: JSON.stringify({ error: "invitation delivery unavailable" }),
};

export interface RemoteSurfaceOptions {
  readonly invitationDeliveryAvailable: boolean;
  readonly upstreamCredentialPathLoggingSafe: boolean;
}

function createsOrResendsInvitation(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;

  return (
    /^\/api\/teams\/[^/]+\/invitations$/u.test(path) ||
    /^\/api\/teams\/[^/]+\/invitations\/[^/]+\/resend$/u.test(path)
  );
}

/**
 * Fail-closed gates around incomplete remote adapters. The application underneath
 * remains the canonical Lesto route surface; this wrapper only withholds paths
 * whose remote prerequisites have not been proven.
 */
export function remoteSafetyPolicy(app: App, options: RemoteSurfaceOptions): App {
  return {
    migrationsApplied: app.migrationsApplied,

    handle(method, path, requestOptions) {
      if (path.startsWith("/api/dev/")) return Promise.resolve(notFound);

      if (
        !options.upstreamCredentialPathLoggingSafe &&
        method.toUpperCase() === "GET" &&
        path.startsWith("/calendar/feed/")
      ) {
        return Promise.resolve(notFound);
      }

      if (!options.invitationDeliveryAvailable && createsOrResendsInvitation(method, path)) {
        return Promise.resolve(invitationDeliveryUnavailable);
      }

      return app.handle(method, path, requestOptions);
    },
  };
}
