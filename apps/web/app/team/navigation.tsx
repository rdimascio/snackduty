import type { ReactNode } from "react";

export const appSections = [
  { href: "/app", label: "Overview" },
  { href: "/app/team", label: "Team" },
  { href: "/app/roster", label: "Roster" },
  { href: "/app/schedule", label: "Schedule" },
  { href: "/app/duties", label: "Duties" },
] as const;

export type AppSectionHref = (typeof appSections)[number]["href"];

export function sectionForPath(pathname: string): AppSectionHref | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  if (path === "/app") return "/app";
  return appSections.find(
    (section) =>
      section.href !== "/app" && (path === section.href || path.startsWith(`${section.href}/`)),
  )?.href;
}

const linkClassName = "block rounded-lg px-3 py-2.5 transition-colors";
const currentClassName = "bg-sidebar-accent font-semibold text-sidebar-accent-foreground";
const otherClassName = "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground";

export function AppNavigationLinks({ current }: { current?: AppSectionHref }): ReactNode {
  return (
    <nav aria-label="Team workspace" className="space-y-1">
      {appSections.map((section) => {
        const isCurrent = section.href === current;
        return (
          <a
            aria-current={isCurrent ? "page" : undefined}
            className={`${linkClassName} ${isCurrent ? currentClassName : otherClassName}`}
            href={section.href}
            key={section.href}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
