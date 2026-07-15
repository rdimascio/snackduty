import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@lesto/ui";
import { defineClientEnv } from "@lesto/env/client";

import { clientEnv } from "../../env.client";

// PUBLIC config, read in the browser from the SHARED `env.client.ts` schema (the same
// one `env.ts` validates and the bundler inlines). `@lesto/env/client` is the
// browser-safe surface: by construction it can hold no secret. NEVER import `../../env`
// (the server schema) here — reaching a server var from an island throws ENV_SERVER_LEAK.
const publicEnv = defineClientEnv(clientEnv);

/** A trivial interactive component: the local count proves hydration is live. */
function Counter({ start }: { start: number }): ReactElement {
  const [n, setN] = useState(start);

  return (
    <button
      type="button"
      data-testid="counter"
      title={publicEnv.PUBLIC_APP_NAME}
      onClick={() => setN((value) => value + 1)}
    >
      count: {n}
    </button>
  );
}

/** Deferred island: server paints the fallback, the client mounts Counter fresh. */
export default defineIsland({
  name: "Counter",
  component: Counter,
  fallback: ({ start }) => (
    <button type="button" data-testid="counter">
      count: {start}
    </button>
  ),
});
