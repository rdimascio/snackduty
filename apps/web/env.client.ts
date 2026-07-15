import { envField } from "@lesto/env/client";
import type { ClientSchema } from "@lesto/env/client";

/**
 * The PUBLIC config the app ships to the browser — every key MUST be `PUBLIC_*`. The
 * bundler inlines these into island code (`lesto build`/`dev`), so `defineClientEnv`
 * resolves them in the browser with no `process.env`. A `.default()` makes a var
 * optional; drop it for a REQUIRED one (a missing value then fails the build, not at
 * hydration). NEVER put a secret here — only `PUBLIC_*` names are accepted.
 */
export const clientEnv = {
  PUBLIC_APP_NAME: envField.string().default("Lesto app"),
} satisfies ClientSchema;
