import type { Lesto } from "@lesto/web";
import { appleSignInInputSchema } from "@snackday/domain";

import type { AuthenticationOperations } from "./application-contracts";

const authenticationRequired = { error: "authentication required" } as const;
const authenticationFailed = { error: "authentication failed" } as const;

/** Register the frozen Apple/session HTTP contract over reusable operations. */
export function registerSessionRoutes(app: Lesto, authentication: AuthenticationOperations) {
  return app
    .post("/api/auth/apple/challenge", async (c) => c.json(await authentication.challenge()))
    .post("/api/auth/apple/sign-in", async (c) => {
      const signedIn = await authentication.signIn(c.valid(appleSignInInputSchema));
      if (signedIn === undefined) return c.json(authenticationFailed, 401);
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": signedIn.cookie,
        },
        body: JSON.stringify(signedIn.identity),
      };
    })
    .get("/api/session", async (c) => {
      const identity = await authentication.current(c.header("cookie"));
      return identity === undefined ? c.json(authenticationRequired, 401) : c.json(identity);
    })
    .post("/api/session/logout", async (c) => ({
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": await authentication.logout(c.header("cookie")),
      },
      body: JSON.stringify({ signedOut: true }),
    }));
}
