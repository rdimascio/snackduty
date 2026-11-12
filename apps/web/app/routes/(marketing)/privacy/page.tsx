import type { ReactNode } from "react";

import type { PageDef } from "@lesto/web";

import { REEL_MEDIA_ORIGIN } from "../../../server/content-security-policy";

const REEL_MEDIA_HOST = new URL(REEL_MEDIA_ORIGIN).host;
const PRIVACY_CONTACT_EMAIL = "privacy@snackduty.com";

interface PolicySection {
  readonly heading: string;
  readonly points: readonly string[];
}

const sections: readonly PolicySection[] = [
  {
    heading: "Who uses Snackday",
    points: [
      "Snackday is for adults: coaches, guardians and other team adults. Children do not get accounts and do not sign in.",
      "A guardian or a coach adds a child to a team. Only adults give us information about a child.",
    ],
  },
  {
    heading: "What we keep about adults",
    points: [
      "Your name and the email address you sign in with.",
      "Which teams you belong to, your role on each team, and the children you are a guardian of.",
      "Your RSVPs, the duties you claim, and the invitations you send or accept.",
      "A record that you confirmed you are an adult, and when.",
    ],
  },
  {
    heading: "What we keep about children",
    points: [
      "Their name and, if an adult enters it, their birth date.",
      "The teams and seasons they are on, attendance and RSVPs, and their guardians.",
      "Answers to team lessons and the skill ratings that come from them.",
      "Coaches see only the children on their own teams. Other families see only what a team shares with them.",
    ],
  },
  {
    heading: "What we do not do",
    points: [
      "We do not sell personal information or use it for advertising.",
      "We do not put children's information in logs, analytics or notification previews.",
      "We do not load scripts or trackers from other companies.",
    ],
  },
  {
    heading: "Who else handles data",
    points: [
      "Our email provider delivers sign-in links and team invitations. It receives the recipient's address and the email text.",
      "Our hosting provider runs the servers and stores the database.",
      `Lesson pictures load from ${REEL_MEDIA_HOST}, which sees your network address when your browser loads them.`,
    ],
  },
  {
    heading: "How long we keep data, and how to erase it",
    points: [
      "We keep data while your account or team uses it.",
      "On the Account page, a guardian invited by another adult can erase a child's data from every team at once, and any adult can erase their own account.",
      "Erasing a child removes their name, birth date, attendance, RSVPs, lesson answers and ratings. It cannot be undone.",
      "Erasing an account removes your name, email addresses, sign-in methods and team access. Team records you created keep a placeholder name.",
    ],
  },
];

function PrivacyPage(): ReactNode {
  return (
    <article className="mx-auto max-w-3xl px-5 py-16 lg:py-24">
      <p
        className="mb-8 rounded-xl border border-dashed border-border bg-accent p-4 text-sm font-semibold"
        role="note"
      >
        Draft. This policy has not had a legal review yet.
      </p>
      <h1 className="text-4xl font-black tracking-tight">Privacy policy</h1>
      <p className="mt-4 text-muted-foreground">
        Snackday helps youth sports teams run their season. This page says what we keep, why, and
        how you erase it.
      </p>
      {sections.map((section) => (
        <section className="mt-10" key={section.heading}>
          <h2 className="text-xl font-bold">{section.heading}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
            {section.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>
      ))}
      <section className="mt-10">
        <h2 className="text-xl font-bold">Contact</h2>
        <p className="mt-3 text-muted-foreground">
          Questions, or a request to see, correct or erase data? Email{" "}
          <a
            className="font-semibold text-primary underline"
            href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
          >
            {PRIVACY_CONTACT_EMAIL}
          </a>
          .
        </p>
      </section>
    </article>
  );
}

const page: PageDef<"/privacy"> = {
  component: PrivacyPage,
  metadata: () => ({
    title: "Privacy — Snackday",
    description: "What Snackday keeps about adults and children, and how to erase it.",
  }),
};

export default page;
