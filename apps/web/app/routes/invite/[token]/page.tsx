import type { ReactNode } from "react";

import type { Context, PageDef } from "@lesto/web";

import { Brand } from "../../../components/brand";
import { EmptyState } from "../../../components/states/empty-state";
import InviteAccept from "../../../islands/invite-accept";
import InviteSignIn from "../../../islands/invite-sign-in";
import { appServices } from "../../../lib/server/app-services";
import { authenticatedAdult } from "../../../lib/server/identity";
import { invitationAcceptedBy, previewInvitation } from "../../../lib/server/invitations";

type InviteData =
  | { readonly state: "app-only" }
  | { readonly state: "invalid" }
  | {
      readonly state: "preview";
      readonly signedIn: boolean;
      readonly teamName: string;
      readonly inviterDisplayName: string;
      readonly invitedRole: string;
      readonly token: string;
    }
  | { readonly state: "accepted"; readonly teamName: string; readonly grantedRole: string };

/**
 * The server loader IS the whole preview path — no new public API route
 * exists: the raw token stays in the URL the invited parent already holds and
 * is hashed in-process by `previewInvitation`, which never logs it. The token
 * IS part of the request line, though, so every access log that records a
 * pathname would carry the live credential: our sinks redact it to
 * `/invite/[redacted]` at the logging seam (`lib/server/access-log.ts`, wired
 * into the edge handler in `worker.ts`). A token in a URL path still reaches
 * parties we do not own — a proxy, a CDN, browser history — which only moving
 * it out of the path would change. Resolution order:
 *
 *   - no registered services (the DB-less edge Worker) → the "open this link
 *     in the app" state — the shell degrades, it never guesses;
 *   - a PENDING, unexpired token → the preview (team, inviter, role — the
 *     delivery payload's exact fields, nothing more), with the signed-in flag
 *     choosing between the Accept button and the sign-in affordance;
 *   - a token THIS signed-in adult already accepted, whose membership is still
 *     in force → the success state naming the role that membership GRANTS, so
 *     a refresh or a re-tap of the link stays calm (accept's idempotent-same-
 *     adult semantics, mirrored);
 *   - everything else — unknown, revoked, expired, accepted by someone else,
 *     or a membership revoked since — ONE generic invalid state; the
 *     difference is never disclosed.
 */
const load = async (c: Context<"/invite/:token">): Promise<InviteData> => {
  const services = appServices();
  if (services === undefined) return { state: "app-only" };

  const token = c.param("token");
  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));

  const preview = await previewInvitation(services.db, token);
  if (preview !== undefined) {
    return { state: "preview", signedIn: identity !== undefined, token, ...preview };
  }

  if (identity !== undefined) {
    const accepted = await invitationAcceptedBy(services.db, token, identity.person.id);
    if (accepted !== undefined) return { state: "accepted", ...accepted };
  }

  return { state: "invalid" };
};

function roleDescription(role: string): string {
  return role === "owner" ? "an owner" : "an adult member";
}

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

function Invalid(): ReactNode {
  return (
    <EmptyState
      description="It may have been used, replaced, or expired. Ask the person who invited you to send a fresh link."
      title="This invite link isn't valid"
    />
  );
}

function Preview({
  invitedRole,
  inviterDisplayName,
  signedIn,
  teamName,
  token,
}: {
  invitedRole: string;
  inviterDisplayName: string;
  signedIn: boolean;
  teamName: string;
  token: string;
}): ReactNode {
  return (
    <div className="text-center">
      <p className="text-sm font-bold text-primary">You&apos;re invited</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{teamName}</h1>
      <p className="mt-2 text-muted-foreground">
        {inviterDisplayName} invited you to join as {roleDescription(invitedRole)}.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        {signedIn ? (
          <InviteAccept token={token} />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Sign in to accept this invitation.</p>
            <InviteSignIn />
          </>
        )}
      </div>
    </div>
  );
}

// The role rendered here is the one the MEMBERSHIP grants (`grantedRole`), not
// the one the invitation asked for: a person is never told they hold a role the
// database withheld.
function Accepted({ grantedRole, teamName }: { grantedRole: string; teamName: string }): ReactNode {
  return (
    <div className="text-center">
      <p className="text-sm font-bold text-primary">Invitation accepted</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
        You&apos;re on {teamName}
      </h1>
      <p className="mt-2 text-muted-foreground">You joined as {roleDescription(grantedRole)}.</p>
      <div className="mt-8">
        <a
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          href="/app"
        >
          Go to your team overview
        </a>
      </div>
    </div>
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
  if (data.state === "invalid") {
    return (
      <InviteShell>
        <Invalid />
      </InviteShell>
    );
  }
  if (data.state === "accepted") {
    return (
      <InviteShell>
        <Accepted grantedRole={data.grantedRole} teamName={data.teamName} />
      </InviteShell>
    );
  }

  return (
    <InviteShell>
      <Preview
        invitedRole={data.invitedRole}
        inviterDisplayName={data.inviterDisplayName}
        signedIn={data.signedIn}
        teamName={data.teamName}
        token={data.token}
      />
    </InviteShell>
  );
}

const page: PageDef<"/invite/:token", InviteData> = {
  component: InvitePage,
  load,
  metadata: () => ({
    title: "You're invited — Snackday",
    description: "Accept your invitation to join a team on Snackday.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
