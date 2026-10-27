import type { ReactNode } from "react";
import { useState } from "react";

import { defineIsland } from "@lesto/ui";

import { browserFetcher, setCoCoach } from "../team/team-actions";
import { MemberList, MemberRow, secondaryButtonClassName } from "../team/team-view";
import type { MemberView } from "../team/team-view";

type TeamMembersProps = {
  readonly teamId: string;
  readonly members: readonly MemberView[];
  readonly viewerPersonId: string;
};

function TeamMembers({ teamId, members: initial, viewerPersonId }: TeamMembersProps): ReactNode {
  const [members, setMembers] = useState(initial);
  const [pending, setPending] = useState<string | undefined>();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | undefined>();

  async function change(member: MemberView, grant: boolean): Promise<void> {
    setPending(member.personId);
    setMessage(undefined);
    const result = await setCoCoach(browserFetcher, teamId, member.personId, grant);
    setPending(undefined);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.message });
      return;
    }
    setMembers((current) =>
      current.map((candidate) =>
        candidate.personId === member.personId
          ? { ...candidate, role: result.value.role }
          : candidate,
      ),
    );
    setMessage({
      tone: "ok",
      text: grant
        ? `${member.displayName} is now a co-coach.`
        : `${member.displayName} is no longer a co-coach.`,
    });
  }

  function action(member: MemberView): ReactNode {
    if (member.role === "owner") return undefined;
    const grant = member.role === "adult";
    return (
      <button
        className={secondaryButtonClassName}
        disabled={pending !== undefined}
        onClick={() => void change(member, grant)}
        type="button"
      >
        {pending === member.personId
          ? "Saving…"
          : grant
            ? `Make ${member.displayName} a co-coach`
            : `Remove ${member.displayName} as co-coach`}
      </button>
    );
  }

  return (
    <div>
      <ul aria-label="Adult members" className="divide-y divide-border">
        {members.map((member) => (
          <MemberRow
            action={action(member)}
            key={member.personId}
            member={member}
            viewerPersonId={viewerPersonId}
          />
        ))}
      </ul>
      <p
        aria-live="polite"
        className={`mt-3 text-sm ${message?.tone === "error" ? "font-semibold text-destructive" : "text-muted-foreground"}`}
        role={message?.tone === "error" ? "alert" : "status"}
      >
        {message?.text ?? ""}
      </p>
    </div>
  );
}

function TeamMembersFallback({ members, viewerPersonId }: TeamMembersProps): ReactNode {
  return <MemberList members={members} viewerPersonId={viewerPersonId} />;
}

export default defineIsland({
  component: TeamMembers,
  fallback: TeamMembersFallback,
  name: "TeamMembers",
});
