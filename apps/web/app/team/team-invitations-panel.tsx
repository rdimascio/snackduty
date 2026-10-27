import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import { absoluteUrl, CopyField } from "./copy-field";
import {
  browserFetcher,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
} from "./team-actions";
import type { Fetcher, InvitationView } from "./team-actions";
import {
  dangerButtonClassName,
  InvitationSummary,
  inputClassName,
  isOpenInvitation,
  labelClassName,
  OpenInvitationList,
  primaryButtonClassName,
  secondaryButtonClassName,
} from "./team-view";

export type TeamInvitationsProps = {
  readonly teamId: string;
  readonly invitations: readonly InvitationView[];
};

type Notice =
  | { readonly tone: "ok"; readonly text: string; readonly link?: string }
  | { readonly tone: "error"; readonly text: string };

const staleListMessage =
  "We could not reload the invitation list, so it may be out of date. Reload the page to see the latest.";

export function withInvitation(
  invitations: readonly InvitationView[],
  changed: InvitationView & { readonly inviteUrl?: string },
): readonly InvitationView[] {
  const { inviteUrl: _link, ...view } = changed;
  return invitations.some((invitation) => invitation.id === view.id)
    ? invitations.map((invitation) => (invitation.id === view.id ? view : invitation))
    : [...invitations, view];
}

export function TeamInvitationsPanel({
  teamId,
  invitations: initial,
  fetcher = browserFetcher,
}: TeamInvitationsProps & { readonly fetcher?: Fetcher }): ReactNode {
  const [invitations, setInvitations] = useState(initial);
  const [listStale, setListStale] = useState(false);
  const [inviteeLabel, setInviteeLabel] = useState("");
  const [email, setEmail] = useState("");
  const [invitedRole, setInvitedRole] = useState<"adult" | "owner">("adult");
  const [pending, setPending] = useState<string | undefined>();
  const [notice, setNotice] = useState<Notice | undefined>();

  async function applyAndRefresh(changed: InvitationView): Promise<void> {
    setInvitations((current) => withInvitation(current, changed));
    const listed = await listInvitations(fetcher, teamId);
    if (listed.ok) {
      setInvitations(listed.value);
      setListStale(false);
    } else {
      setListStale(true);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending("send");
    setNotice(undefined);
    const result = await sendInvitation(fetcher, teamId, {
      inviteeLabel: inviteeLabel.trim(),
      invitedRole,
      email: email.trim(),
    });
    if (!result.ok) {
      setPending(undefined);
      setNotice({ tone: "error", text: result.message });
      return;
    }
    setInviteeLabel("");
    setEmail("");
    await applyAndRefresh(result.value);
    setPending(undefined);
    setNotice({
      tone: "ok",
      text: `Invitation sent to ${result.value.inviteeLabel}.`,
      ...(result.value.inviteUrl === undefined ? {} : { link: result.value.inviteUrl }),
    });
  }

  async function resend(invitation: InvitationView): Promise<void> {
    setPending(invitation.id);
    setNotice(undefined);
    const result = await resendInvitation(fetcher, teamId, invitation.id);
    if (!result.ok) {
      setPending(undefined);
      setNotice({ tone: "error", text: result.message });
      return;
    }
    await applyAndRefresh(result.value);
    setPending(undefined);
    setNotice({
      tone: "ok",
      text: `Invitation resent to ${invitation.inviteeLabel}. The old link no longer works.`,
      ...(result.value.inviteUrl === undefined ? {} : { link: result.value.inviteUrl }),
    });
  }

  async function revoke(invitation: InvitationView): Promise<void> {
    setPending(invitation.id);
    setNotice(undefined);
    const result = await revokeInvitation(fetcher, teamId, invitation.id);
    if (!result.ok) {
      setPending(undefined);
      setNotice({ tone: "error", text: result.message });
      return;
    }
    await applyAndRefresh(result.value);
    setPending(undefined);
    setNotice({ tone: "ok", text: `Invitation for ${invitation.inviteeLabel} revoked.` });
  }

  const open = invitations.filter(isOpenInvitation);
  const busy = pending !== undefined;

  return (
    <div className="space-y-6">
      <form
        aria-label="Send an invitation"
        className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2"
        onSubmit={(event) => void send(event)}
      >
        <label className={labelClassName}>
          Name
          <input
            className={inputClassName}
            maxLength={80}
            name="inviteeLabel"
            onChange={(event) => setInviteeLabel(event.currentTarget.value)}
            placeholder="Jordan Lee"
            required
            value={inviteeLabel}
          />
        </label>
        <label className={labelClassName}>
          Email
          <input
            autoComplete="off"
            className={inputClassName}
            name="email"
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="jordan@example.com"
            required
            type="email"
            value={email}
          />
        </label>
        <label className={labelClassName}>
          Role
          <select
            className={inputClassName}
            name="invitedRole"
            onChange={(event) =>
              setInvitedRole(event.currentTarget.value === "owner" ? "owner" : "adult")
            }
            value={invitedRole}
          >
            <option value="adult">Adult member</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <div className="flex items-end">
          <button className={primaryButtonClassName} disabled={busy} type="submit">
            {pending === "send" ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>

      <div aria-live="polite">
        {notice === undefined ? null : notice.tone === "error" ? (
          <p className="text-sm font-semibold text-destructive" role="alert">
            {notice.text}
          </p>
        ) : (
          <div className="space-y-3 rounded-xl bg-muted/60 p-4" role="status">
            <p className="text-sm font-semibold">{notice.text}</p>
            {notice.link === undefined ? null : (
              <CopyField
                label="Invite link (development delivery)"
                value={absoluteUrl(notice.link)}
              />
            )}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-bold">Pending invitations</h3>
        {listStale ? (
          <p className="mt-2 text-sm font-semibold text-destructive" role="alert">
            {staleListMessage}
          </p>
        ) : null}
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No pending invitations.</p>
        ) : (
          <ul aria-label="Pending invitations" className="mt-2 divide-y divide-border">
            {open.map((invitation) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                key={invitation.id}
              >
                <InvitationSummary invitation={invitation} />
                <div className="flex flex-wrap gap-2">
                  <button
                    className={secondaryButtonClassName}
                    disabled={busy}
                    onClick={() => void resend(invitation)}
                    type="button"
                  >
                    {pending === invitation.id ? "Working…" : "Resend"}
                    <span className="sr-only"> invitation for {invitation.inviteeLabel}</span>
                  </button>
                  <button
                    className={dangerButtonClassName}
                    disabled={busy}
                    onClick={() => void revoke(invitation)}
                    type="button"
                  >
                    Revoke
                    <span className="sr-only"> invitation for {invitation.inviteeLabel}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function TeamInvitationsFallback({ invitations }: TeamInvitationsProps): ReactNode {
  return (
    <div>
      <h3 className="font-bold">Pending invitations</h3>
      <div className="mt-2">
        <OpenInvitationList invitations={invitations} />
      </div>
    </div>
  );
}
