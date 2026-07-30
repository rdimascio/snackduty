import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { EmptyState } from "../../components/states/empty-state";
import { appServices } from "../../lib/server/app-services";
import { authenticatedAdult } from "../../lib/server/identity";
import { listOwnedTeams, loadRoster } from "../../lib/server/team-reads";
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
 * the same owner-scoped helpers the /api/teams routes use, so the page and the
 * API cannot drift. Unauthenticated — or on the DB-less edge Worker, where no
 * services are registered — it resolves to the signed-out state: the shell is
 * not an authorization boundary, the DATA path is.
 */
const load = async (c: Context<"/app">): Promise<OverviewData> => {
  const services = appServices();
  if (services === undefined) return { state: "signed-out" };

  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) return { state: "signed-out" };

  const owned = await listOwnedTeams(services.db, identity.person.id);
  const first = owned[0];
  if (first === undefined) return { state: "no-team" };

  const season = first.seasons[0];
  return {
    state: "team",
    teamName: first.team.name,
    seasonLabel: season?.label,
    roster: season === undefined ? [] : await loadRoster(services.db, first.team.id, season.id),
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
          <GuardianList guardians={entry.guardians} />
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
