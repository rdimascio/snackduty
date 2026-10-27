import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import DevSignInIsland from "../islands/dev-sign-in";
import type { DevSignInPersona } from "../islands/dev-sign-in";
import { appServices } from "../lib/server/app-services";
import { authenticatedAdult } from "../lib/server/identity";
import { DEV_SIGN_IN_PAGE_PATH, SEED_PERSONAS } from "./seed-personas";

type DevSignInPath = typeof DEV_SIGN_IN_PAGE_PATH;

interface DevSignInData {
  readonly personas: readonly DevSignInPersona[];
  readonly signedInAs?: { readonly displayName: string; readonly personaKey?: string };
}

const personas: readonly DevSignInPersona[] = SEED_PERSONAS.map((persona) => ({
  key: persona.key,
  displayName: persona.displayName,
  email: persona.email,
  role: persona.role,
  can: persona.can,
}));

const load = async (c: Context<DevSignInPath>): Promise<DevSignInData> => {
  const services = appServices(c);
  if (services === undefined) return { personas };
  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) return { personas };
  const persona = SEED_PERSONAS.find((candidate) => candidate.personId === identity.person.id);
  return {
    personas,
    signedInAs: {
      displayName: identity.person.displayName,
      ...(persona === undefined ? {} : { personaKey: persona.key }),
    },
  };
};

function DevSignInPage(data: PageProps<typeof load>): ReactNode {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10" id="main-content">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-muted-foreground">Development only</p>
        <h1 className="text-3xl font-semibold">Sign in as a seeded role</h1>
        <p className="text-muted-foreground">
          Each button signs this browser in as one adult from the SQL seed and opens the app.
        </p>
        <p className="text-sm" role="status">
          {data.signedInAs === undefined
            ? "Nobody is signed in."
            : `Signed in as ${data.signedInAs.displayName}.`}
        </p>
      </header>
      <DevSignInIsland
        personas={data.personas}
        {...(data.signedInAs?.personaKey === undefined
          ? {}
          : { currentPersonaKey: data.signedInAs.personaKey })}
      />
    </main>
  );
}

export const devSignInPage: PageDef<DevSignInPath, DevSignInData> = {
  component: DevSignInPage,
  load,
  metadata: () => ({
    title: "Development sign-in — Snackday",
    description: "Switch between the seeded development roles.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};
