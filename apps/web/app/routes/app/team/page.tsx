import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

import { EmptyState } from "../../../components/states/empty-state";
import TeamCalendarFeedIsland from "../../../islands/team-calendar-feed";
import TeamInvitationsIsland from "../../../islands/team-invitations";
import TeamMembersIsland from "../../../islands/team-members";
import TeamSeasonFormIsland from "../../../islands/team-season-form";
import { appServices } from "../../../lib/server/app-services";
import { authenticatedAdult } from "../../../lib/server/identity";
import { loadTeamPage } from "../../../team/team-page-data";
import type { SeasonView, TeamPageData, TeamPageTeam } from "../../../team/team-page-data";
import { formatDate, MemberList, roleLabel, SectionCard } from "../../../team/team-view";

function queryValue(c: Context<"/app/team">, name: string): string | undefined {
  const value = c.query(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const load = async (c: Context<"/app/team">): Promise<TeamPageData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };

  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  if (identity === undefined) return { state: "signed-out" };

  const data = await loadTeamPage(
    services.db,
    identity.person.id,
    { teamId: queryValue(c, "team"), seasonId: queryValue(c, "season") },
    services.clock,
  );
  if (data.state === "not-found") c.status(404);
  return data;
};

function teamHref(teamId: string, seasonId?: string): string {
  const query = new URLSearchParams({ team: teamId });
  if (seasonId !== undefined) query.set("season", seasonId);
  return `/app/team?${query.toString()}`;
}

function PageIntro({ title, lede }: { title: string; lede: string }): ReactNode {
  return (
    <div>
      <p className="text-sm font-bold text-primary">Team</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-muted-foreground">{lede}</p>
    </div>
  );
}

function SignedOut(): ReactNode {
  return (
    <div>
      <PageIntro lede="Sign in to see your team, its seasons, and its adults." title="Your team" />
      <div className="mt-8">
        <EmptyState
          description="Team details are private to the team's signed-in adults, so nothing is shown until you sign in."
          title="Signed out"
        />
      </div>
    </div>
  );
}

function NoTeam(): ReactNode {
  return (
    <div>
      <PageIntro lede="You are signed in, but you are not on a team yet." title="Your team" />
      <div className="mt-8">
        <EmptyState
          description="Create a team in the Snackday app, or open an invitation link from a coach to join one."
          title="No team yet"
        />
      </div>
    </div>
  );
}

function TeamNotFound(): ReactNode {
  return (
    <div>
      <PageIntro lede="This team or season is not available to you." title="Team not found" />
      <div className="mt-8">
        <EmptyState
          action={
            <a
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
              href="/app/team"
            >
              Go to your team
            </a>
          }
          description="The link may be old, or you may not be on this team. Ask the team owner for an invitation."
          title="Nothing to show here"
        />
      </div>
    </div>
  );
}

function TeamSwitcher({ data }: { data: TeamPageTeam }): ReactNode {
  if (data.teams.length < 2) return null;
  return (
    <nav aria-label="Your teams" className="flex flex-wrap gap-2">
      {data.teams.map((team) => {
        const current = team.id === data.teamId;
        return (
          <a
            aria-current={current ? "page" : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${current ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}
            href={teamHref(team.id)}
            key={team.id}
          >
            {team.name}
          </a>
        );
      })}
    </nav>
  );
}

function TeamFacts({ data }: { data: TeamPageTeam }): ReactNode {
  return (
    <dl className="mt-5 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Sport</dt>
        <dd className="mt-1 font-semibold">
          Not set{" "}
          <span className="font-normal text-muted-foreground">
            (Snackday does not store a sport yet)
          </span>
        </dd>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Active season
        </dt>
        <dd className="mt-1 font-semibold">{data.season?.label ?? "No season yet"}</dd>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Your role
        </dt>
        <dd className="mt-1 font-semibold">{roleLabel(data.viewerRole)}</dd>
      </div>
    </dl>
  );
}

function SeasonDetails({ season }: { season: SeasonView }): ReactNode {
  return (
    <div className="rounded-xl bg-muted/60 p-4">
      <p className="text-lg font-bold">{season.label}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {formatDate(season.startDate)} to {formatDate(season.endDate)} · {season.timeZone}
      </p>
    </div>
  );
}

function SeasonSwitcher({ data }: { data: TeamPageTeam }): ReactNode {
  if (data.seasons.length < 2) return null;
  return (
    <nav aria-label="Switch season" className="mt-4">
      <p className="text-sm font-semibold">Switch season</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {data.seasons.map((season) => {
          const current = season.id === data.season?.id;
          return (
            <li key={season.id}>
              <a
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg border px-3 py-2 text-sm font-semibold ${current ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}
                href={teamHref(data.teamId, season.id)}
              >
                {season.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SeasonsSection({ data }: { data: TeamPageTeam }): ReactNode {
  return (
    <SectionCard
      description={
        data.canManage
          ? "Pick the season you are working in, or start a new one."
          : "Pick the season you want to see."
      }
      id="team-seasons"
      title="Seasons"
    >
      {data.season === undefined ? (
        <p className="text-sm text-muted-foreground">
          {data.canManage
            ? "This team has no season yet. Create one to start a roster and a schedule."
            : "This team has no season yet. A coach will create one."}
        </p>
      ) : (
        <SeasonDetails season={data.season} />
      )}
      <SeasonSwitcher data={data} />
      {data.canManage ? (
        <div className="mt-5">
          <TeamSeasonFormIsland teamId={data.teamId} />
        </div>
      ) : null}
    </SectionCard>
  );
}

function MembersSection({ data }: { data: TeamPageTeam }): ReactNode {
  return (
    <SectionCard
      description={
        data.canDelegate
          ? "Adults on this team. Make an adult member a co-coach so they can help run the team."
          : "Adults on this team."
      }
      id="team-members"
      title="Members"
    >
      {data.canDelegate ? (
        <TeamMembersIsland
          members={data.members}
          teamId={data.teamId}
          viewerPersonId={data.viewerPersonId}
        />
      ) : (
        <MemberList members={data.members} viewerPersonId={data.viewerPersonId} />
      )}
    </SectionCard>
  );
}

function InvitationsSection({ data }: { data: TeamPageTeam }): ReactNode {
  if (data.invitations === undefined) return null;
  return (
    <SectionCard
      description="Invite an adult by email. Only the person with that email can accept."
      id="team-invitations"
      title="Invitations"
    >
      <TeamInvitationsIsland invitations={data.invitations} teamId={data.teamId} />
    </SectionCard>
  );
}

function CalendarSection({ data }: { data: TeamPageTeam }): ReactNode {
  return (
    <SectionCard
      description="Subscribe to this team's schedule in Apple Calendar or Google Calendar. The link is private to you."
      id="team-calendar"
      title="Calendar feed"
    >
      <TeamCalendarFeedIsland active={data.feedActive} teamId={data.teamId} />
    </SectionCard>
  );
}

function TeamDetails({ data }: { data: TeamPageTeam }): ReactNode {
  return (
    <div>
      <TeamSwitcher data={data} />
      <div className={data.teams.length > 1 ? "mt-6" : ""}>
        <PageIntro
          lede={
            data.canManage
              ? "Seasons, adults, invitations, and your calendar feed."
              : "Your team's seasons and adults. Only owners and co-coaches can change them."
          }
          title={data.teamName}
        />
      </div>
      <TeamFacts data={data} />
      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <SeasonsSection data={data} />
        <MembersSection data={data} />
        <InvitationsSection data={data} />
        <CalendarSection data={data} />
      </div>
    </div>
  );
}

function TeamPage(data: PageProps<typeof load>): ReactNode {
  if (data.state === "signed-out") return <SignedOut />;
  if (data.state === "no-team") return <NoTeam />;
  if (data.state === "not-found") return <TeamNotFound />;
  return <TeamDetails data={data} />;
}

const page: PageDef<"/app/team", TeamPageData> = {
  component: TeamPage,
  load,
  metadata: (data) => ({
    title: data.state === "team" ? `${data.teamName} — Team — Snackday` : "Team — Snackday",
    description: "Your Snackday team: seasons, adult members, invitations, and calendar feed.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;
