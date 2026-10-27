import type { ReactNode } from "react";

import type { InvitationView } from "./team-actions";

export interface MemberView {
  readonly personId: string;
  readonly displayName: string;
  readonly role: "owner" | "coach" | "adult";
  readonly creator: boolean;
}

export const primaryButtonClassName =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClassName =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-card-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButtonClassName =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-destructive/40 bg-card px-4 py-2 text-sm font-semibold text-destructive shadow-sm transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60";

export const inputClassName =
  "mt-1 block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground";

export const labelClassName = "block text-sm font-semibold";

export function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "coach") return "Co-coach";
  return "Adult member";
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(isoDate: string): string {
  const parsed = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  return Number.isNaN(parsed.getTime()) ? isoDate : dateFormat.format(parsed);
}

export function SectionCard({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  id: string;
}): ReactNode {
  return (
    <section
      aria-labelledby={id}
      className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 className="text-xl font-bold" id={id}>
        {title}
      </h2>
      {description === undefined ? null : (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function RoleBadge({ role }: { role: string }): ReactNode {
  const tone =
    role === "owner"
      ? "bg-primary/15 text-foreground"
      : role === "coach"
        ? "bg-accent text-accent-foreground"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}>
      {roleLabel(role)}
    </span>
  );
}

export function MemberRow({
  member,
  viewerPersonId,
  action,
}: {
  member: MemberView;
  viewerPersonId: string | undefined;
  action?: ReactNode;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="font-semibold">
          {member.displayName}
          {member.personId === viewerPersonId ? (
            <span className="font-normal text-muted-foreground"> (you)</span>
          ) : null}
        </p>
        <div className="mt-1">
          <RoleBadge role={member.role} />
        </div>
      </div>
      {action === undefined ? null : <div className="flex items-center gap-2">{action}</div>}
    </li>
  );
}

export function MemberList({
  members,
  viewerPersonId,
}: {
  members: readonly MemberView[];
  viewerPersonId?: string;
}): ReactNode {
  if (members.length === 0) {
    return <p className="text-sm text-muted-foreground">No adults are on this team yet.</p>;
  }
  return (
    <ul aria-label="Adult members" className="divide-y divide-border">
      {members.map((member) => (
        <MemberRow key={member.personId} member={member} viewerPersonId={viewerPersonId} />
      ))}
    </ul>
  );
}

export function invitationStatusLabel(status: string): string {
  if (status === "pending") return "Pending";
  if (status === "expired") return "Expired";
  if (status === "accepted") return "Accepted";
  if (status === "revoked") return "Revoked";
  return status;
}

export function isOpenInvitation(invitation: Pick<InvitationView, "status">): boolean {
  return invitation.status === "pending" || invitation.status === "expired";
}

export function InvitationSummary({ invitation }: { invitation: InvitationView }): ReactNode {
  return (
    <div className="min-w-0">
      <p className="font-semibold break-words">{invitation.inviteeLabel}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {invitation.forChild ? "Guardian" : roleLabel(invitation.invitedRole)} ·{" "}
        {invitationStatusLabel(invitation.status)}
        {invitation.status === "pending" ? ` · expires ${formatDate(invitation.expiresAt)}` : null}
      </p>
    </div>
  );
}

export function OpenInvitationList({
  invitations,
}: {
  invitations: readonly InvitationView[];
}): ReactNode {
  const open = invitations.filter(isOpenInvitation);
  if (open.length === 0) {
    return <p className="text-sm text-muted-foreground">No pending invitations.</p>;
  }
  return (
    <ul aria-label="Pending invitations" className="divide-y divide-border">
      {open.map((invitation) => (
        <li className="py-3" key={invitation.id}>
          <InvitationSummary invitation={invitation} />
        </li>
      ))}
    </ul>
  );
}
