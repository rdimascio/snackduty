import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { EmptyState } from "../../components/states/empty-state";
import { appServices } from "../../lib/server/app-services";
import { authenticatedAdult } from "../../lib/server/identity";
import { listAccessibleTeams, loadRoster } from "../../lib/server/team-reads";
import type { RosterEntry } from "../../lib/server/team-reads";

type OverviewData =
  | { readonly state: "signed-out" }
  | { readonly state: "no-team" }
  | {
      readonly state: "team";
      readonly teamName: string;
      readonly seasonLabel: string | undefined;
      readonly roster: readonly RosterEntry[];
    };

/**
 * The server loader IS the authorized read path: it resolves the signed-in
 * adult from the request's session cookie and reads that adult's data through
 * the same access-scoped helpers the /api/teams routes use, so the page and
 * the API cannot drift — teams the adult created AND teams they joined by
 * invitation both appear. Unauthenticated — or on the DB-less edge Worker,
 * where no services are registered — it resolves to the signed-out state: the
 * shell is not an authorization boundary, the DATA path is.
 */
const load = async (c: Context<"/app">): Promise<OverviewData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };

  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) return { state: "signed-out" };

  const accessible = await listAccessibleTeams(services.db, identity.person.id);
  const first = accessible[0];
  if (first === undefined) return { state: "no-team" };

  const season = first.seasons[0];
  return {
    state: "team",
    teamName: first.team.name,
    seasonLabel: season?.label,
    roster:
      season === undefined
        ? []
        : await loadRoster(
            services.db,
            first.team.id,
            season.id,
            {
              personId: identity.person.id,
              access: first.access,
            },
            services.clock,
          ),
  };
};

function OverviewIntro({ lede }: { lede: string }): ReactNode {
  return (
    <div>
      <p className="text-sm font-bold text-primary">Welcome to Snackday</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
        Your team, at a glance
      </h1>
      <p className="mt-2 text-muted-foreground">{lede}</p>
    </div>
  );
}

function SignedOut(): ReactNode {
  return (
    <div>
      <OverviewIntro lede="Sign in and this overview loads your real team, season, and roster." />
      <div className="mt-8">
        <EmptyState
          description="Team data is private to its signed-in adults, so nothing is shown until you sign in."
          title="Signed out"
        />
      </div>
    </div>
  );
}

function NoTeam(): ReactNode {
  return (
    <div>
      <OverviewIntro lede="You are signed in, but no team exists yet." />
      <div className="mt-8">
        <EmptyState
          description="Create your team and season, and this overview will show the real roster."
          title="No team yet"
        />
      </div>
    </div>
  );
}

function GuardianList({ guardians }: { guardians: RosterEntry["guardians"] }): ReactNode {
  if (guardians.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No guardians on file yet.</p>;
  }

  return (
    <ul aria-label="Guardians" className="mt-3 space-y-1">
      {guardians.map((guardian) => (
        <li className="text-sm" key={guardian.guardianId}>
          <span className="font-semibold">{guardian.displayName}</span>{" "}
          <span className="text-muted-foreground">({guardian.relationship})</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The child's invitation state, as COUNTS. The roster projection deliberately
 * carries no invitee label and no link (team-reads.ts explains why), so this
 * line can say how many guardian invitations are outstanding without repeating
 * the inviter's wording — which routinely quotes the child.
 */
function InvitationStatus({
  invitations,
}: {
  invitations: NonNullable<RosterEntry["guardianInvitations"]>;
}): ReactNode {
  const parts: string[] = [];
  if (invitations.pending > 0) parts.push(`${invitations.pending} invited`);
  if (invitations.expired > 0) parts.push(`${invitations.expired} expired`);
  if (invitations.accepted > 0) parts.push(`${invitations.accepted} joined`);
  if (parts.length === 0) return null;

  return (
    <p className="mt-2 text-xs text-muted-foreground">Guardian invitations: {parts.join(", ")}</p>
  );
}

function RosterSection({ roster }: { roster: readonly RosterEntry[] }): ReactNode {
  if (roster.length === 0) {
    return (
      <EmptyState
        description="Add participants and their guardians to this season and they will appear here."
        title="No roster yet"
      />
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {roster.map((entry) => (
        <li
          className="rounded-2xl border border-border bg-card p-5 shadow-sm"
          key={entry.participantId}
        >
          <p className="text-xl font-bold">{entry.displayName}</p>
          {entry.birthDate === undefined ? null : (
            <p className="mt-1 text-sm text-muted-foreground">Born {entry.birthDate}</p>
          )}
          {entry.guardianInvitations === undefined ? null : (
            <>
              <GuardianList guardians={entry.guardians} />
              <InvitationStatus invitations={entry.guardianInvitations} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function TeamOverview({
  roster,
  seasonLabel,
  teamName,
}: {
  roster: readonly RosterEntry[];
  seasonLabel: string | undefined;
  teamName: string;
}): ReactNode {
  return (
    <div>
      <div>
        <p className="text-sm font-bold text-primary">Team overview</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{teamName}</h1>
        <p className="mt-2 text-muted-foreground">
          {seasonLabel === undefined ? "No season yet" : seasonLabel}
        </p>
      </div>
      <section aria-label="Roster" className="mt-8">
        <h2 className="text-xl font-bold">Roster</h2>
        <div className="mt-4">
          <RosterSection roster={roster} />
        </div>
      </section>
    </div>
  );
}

function Overview(data: PageProps<typeof load>): ReactNode {
  if (data.state === "signed-out") return <SignedOut />;
  if (data.state === "no-team") return <NoTeam />;

  return (
    <TeamOverview roster={data.roster} seasonLabel={data.seasonLabel} teamName={data.teamName} />
  );
}

const page: PageDef<"/app", OverviewData> = {
  component: Overview,
  load,
  metadata: () => ({
    title: "Team overview — Snackday",
    description: "Your Snackday team workspace for schedules, members, and shared duties.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
