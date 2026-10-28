import type { ReactNode } from "react";

import { EmptyState } from "../components/states/empty-state";
import RosterAddParticipant from "../islands/roster-add-participant";
import RosterImport from "../islands/roster-import";
import RosterLinkGuardian from "../islands/roster-link-guardian";
import { NotFoundState } from "../routes/not-found";
import { rosterHref } from "./roster-data";
import type {
  RosterChild,
  RosterInvitations,
  RosterPageData,
  RosterSeasonChoice,
  RosterTeamChoice,
} from "./roster-data";

type TeamData = Extract<RosterPageData, { state: "no-season" | "error" | "roster" }>;

function RosterIntro({
  title,
  lede,
  eyebrow = "Roster",
}: {
  title: string;
  lede: string;
  eyebrow?: string;
}): ReactNode {
  return (
    <div>
      <p className="text-sm font-bold text-primary">{eyebrow}</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-muted-foreground">{lede}</p>
    </div>
  );
}

function SignedOut(): ReactNode {
  return (
    <div>
      <RosterIntro lede="Sign in to see your team's roster." title="Team roster" />
      <div className="mt-8">
        <EmptyState
          description="Children's details are private to their team's signed-in adults, so nothing is shown until you sign in."
          title="Signed out"
        />
      </div>
    </div>
  );
}

function NoTeam(): ReactNode {
  return (
    <div>
      <RosterIntro lede="You are signed in, but you are not on a team yet." title="Team roster" />
      <div className="mt-8">
        <EmptyState
          description="Create a team, or accept an invitation from a coach, and its roster will show here."
          title="No team yet"
        />
      </div>
    </div>
  );
}

function TeamPicker({
  teams,
  teamId,
  seasonId,
}: {
  teams: readonly RosterTeamChoice[];
  teamId: string;
  seasonId: string | undefined;
}): ReactNode {
  const choices = teams.flatMap((team) =>
    team.seasons.length === 0
      ? [{ team, season: undefined as RosterSeasonChoice | undefined }]
      : team.seasons.map((season) => ({ team, season })),
  );
  if (choices.length < 2) return null;
  return (
    <nav aria-label="Choose a team and season" className="mt-6 flex flex-wrap gap-2">
      {choices.map(({ team, season }) => {
        const current = team.teamId === teamId && season?.seasonId === seasonId;
        return (
          <a
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
                : "rounded-full border border-border bg-card px-3 py-1.5 text-sm font-semibold hover:bg-muted"
            }
            href={rosterHref(team.teamId, season?.seasonId)}
            key={`${team.teamId}:${season?.seasonId ?? "none"}`}
          >
            {team.teamName}
            {season === undefined ? null : (
              <span className={current ? "font-normal" : "font-normal text-muted-foreground"}>
                {" "}
                · {season.label}
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}

function invitationParts(invitations: RosterInvitations): string[] {
  const parts: string[] = [];
  if (invitations.pending > 0) parts.push(`${invitations.pending} invited`);
  if (invitations.expired > 0) parts.push(`${invitations.expired} expired`);
  if (invitations.accepted > 0) parts.push(`${invitations.accepted} joined`);
  return parts;
}

function InvitationLine({ invitations }: { invitations: RosterInvitations }): ReactNode {
  const parts = invitationParts(invitations);
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {`Guardian invitations: ${parts.length === 0 ? "none sent" : parts.join(", ")}`}
    </p>
  );
}

function GuardianList({ guardians }: { guardians: RosterChild["guardians"] }): ReactNode {
  if (guardians.length === 0) {
    return <p className="text-sm text-muted-foreground">No guardians linked yet.</p>;
  }
  return (
    <ul aria-label="Guardians" className="space-y-1">
      {guardians.map((guardian) => (
        <li className="text-sm" key={guardian.guardianId}>
          <span className="font-semibold">{guardian.displayName}</span>{" "}
          <span className="text-muted-foreground">{`(${guardian.relationship})`}</span>
        </li>
      ))}
    </ul>
  );
}

function ageLine(child: RosterChild): string {
  return child.age === undefined ? "Age not on file" : `Age ${child.age}`;
}

function ChildCard({ child, canManage }: { child: RosterChild; canManage: boolean }): ReactNode {
  return (
    <li className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {child.cardHref === undefined ? (
            <p className="text-xl font-bold">{child.displayName}</p>
          ) : (
            <a
              aria-label={`${child.displayName} player card`}
              className="text-xl font-bold underline-offset-4 hover:underline"
              href={child.cardHref}
            >
              {child.displayName}
            </a>
          )}
          <p className="mt-1 text-sm text-muted-foreground">{ageLine(child)}</p>
        </div>
        {child.cardHref === undefined ? null : (
          <a
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold shadow-sm hover:bg-muted"
            href={child.cardHref}
          >
            Player card
          </a>
        )}
      </div>
      <div className="mt-4">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Guardians
        </p>
        <div className="mt-2">
          <GuardianList guardians={child.guardians} />
        </div>
        <InvitationLine invitations={child.invitations} />
      </div>
      {canManage ? (
        <details className="mt-4 rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Link a guardian</summary>
          <div className="mt-3">
            <RosterLinkGuardian childName={child.displayName} participantId={child.participantId} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

function ChildList({
  players,
  canManage,
}: {
  players: readonly RosterChild[];
  canManage: boolean;
}): ReactNode {
  if (players.length === 0) {
    return canManage ? (
      <EmptyState
        description="Add a player below, or import your roster from a CSV file."
        title="No players yet"
      />
    ) : (
      <EmptyState
        description="None of your children are on this season's roster. Ask a coach to add them or to send you an invitation."
        title="No children of yours here"
      />
    );
  }
  return (
    <ul aria-label="Players" className="grid gap-4 md:grid-cols-2">
      {players.map((child) => (
        <ChildCard canManage={canManage} child={child} key={child.participantId} />
      ))}
    </ul>
  );
}

function CoachTools({ teamId, seasonId }: { teamId: string; seasonId: string }): ReactNode {
  return (
    <section aria-label="Coach tools" className="mt-10 grid gap-6 lg:grid-cols-2">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-bold">Add a player</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A child needs no account and no email address.
        </p>
        <div className="mt-4">
          <RosterAddParticipant seasonId={seasonId} teamId={teamId} />
        </div>
      </div>
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-bold">Import from CSV</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Preview every row first. Nothing is saved until you confirm.
        </p>
        <div className="mt-4">
          <RosterImport seasonId={seasonId} teamId={teamId} />
        </div>
      </div>
    </section>
  );
}

function TeamRoster(data: TeamData): ReactNode {
  const seasonId = data.state === "no-season" ? undefined : data.season.seasonId;
  const lede =
    data.state === "no-season"
      ? "No season yet"
      : data.canManage
        ? `${data.season.label} · coach view`
        : `${data.season.label} · your children`;
  return (
    <div>
      <RosterIntro lede={lede} title={data.team.teamName} />
      <TeamPicker seasonId={seasonId} teamId={data.team.teamId} teams={data.teams} />
      <div className="mt-8">
        {data.state === "no-season" ? (
          <EmptyState
            description="Create a season for this team and its roster will show here."
            title="No season yet"
          />
        ) : data.state === "error" ? (
          <section
            className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm"
            role="alert"
          >
            <h2 className="text-lg font-bold">The roster did not load</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Reload the page to try again. Nothing on the roster changed.
            </p>
          </section>
        ) : (
          <ChildList canManage={data.canManage} players={data.children} />
        )}
      </div>
      {data.state === "roster" && data.canManage ? (
        <CoachTools seasonId={data.season.seasonId} teamId={data.team.teamId} />
      ) : null}
    </div>
  );
}

export function RosterPage(data: RosterPageData): ReactNode {
  if (data.state === "signed-out") return <SignedOut />;
  if (data.state === "no-team") return <NoTeam />;
  if (data.state === "not-found") return <NotFoundState />;
  return <TeamRoster {...data} />;
}
