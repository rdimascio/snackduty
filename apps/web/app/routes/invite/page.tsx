import type { ReactNode } from "react";

import type { Context, PageDef } from "@lesto/web";

import { Brand } from "../../components/brand";
import { EmptyState } from "../../components/states/empty-state";
import InviteLanding from "../../islands/invite-landing";
import { appServices } from "../../lib/server/app-services";
import { authenticatedAdult } from "../../lib/server/identity";

type InviteData =
  | { readonly state: "app-only" }
  | { readonly state: "in-browser"; readonly signedIn: boolean };

/**
 * The invitation landing page — deliberately the THINNEST loader in the app.
 *
 * The invitation's bearer token travels in the URL FRAGMENT (`/invite#<token>`,
 * see `lib/server/invitations.ts`'s `inviteUrlFor`), which no browser ever sends
 * to any server. So this loader CANNOT see the token, by construction, and that
 * is the point: the credential can never be written to an access log, a proxy
 * or CDN record, a `Referer`, or an `http.path` span attribute. Preview,
 * accepted, and invalid are therefore resolved in the browser by the landing
 * island, which POSTs the token to `/api/invitations/preview` in a body.
 *
 * What is still resolvable server-side, and all this loader answers:
 *
 *   - no registered services (the DB-less edge Worker) → the "open this link
 *     in the app" state — the shell degrades, it never guesses;
 *   - otherwise, whether a session exists, which chooses between the Accept
 *     button and the sign-in affordance once the island has a preview.
 */
const load = async (c: Context<"/invite">): Promise<InviteData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "app-only" };

  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));

  return { state: "in-browser", signedIn: identity !== undefined };
};

function InviteShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto max-w-2xl px-5 py-16 lg:py-24" id="main-content" tabIndex={-1}>
      <div className="mb-10 flex justify-center">
        <Brand />
      </div>
      {children}
    </main>
  );
}

function AppOnly(): ReactNode {
  return (
    <EmptyState
      description="This invitation can't be shown here. Open the link in the Snackday app to see it."
      title="Open this link in the app"
    />
  );
}

function InvitePage(data: InviteData): ReactNode {
  if (data.state === "app-only") {
    return (
      <InviteShell>
        <AppOnly />
      </InviteShell>
    );
  }

  return (
    <InviteShell>
      <InviteLanding signedIn={data.signedIn} />
      {/* The one page whose content NO server can render: the fragment that
          decides it is only ever readable by script. Say so plainly rather
          than leaving a scripting-disabled visitor at a blank panel. */}
      <noscript>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          This invitation is read in your browser, so it needs JavaScript. Turn it on and reload, or
          open the link in the Snackday app.
        </p>
      </noscript>
    </InviteShell>
  );
}

const page: PageDef<"/invite", InviteData> = {
  component: InvitePage,
  load,
  metadata: () => ({
    title: "You're invited — Snackday",
    description: "Accept your invitation to join a team on Snackday.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
