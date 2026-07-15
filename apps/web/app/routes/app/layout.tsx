import type { ReactNode } from "react";

import { Brand } from "../../components/brand";

const liveNavigation = [{ href: "/app", label: "Overview" }] as const;
const plannedNavigation = ["Team", "Roster", "Schedule", "Duties"] as const;

function ProductNavigation(): ReactNode {
  return (
    <nav aria-label="Team workspace" className="space-y-1">
      {liveNavigation.map((item) => (
        <a
          className="block rounded-lg bg-sidebar-accent px-3 py-2.5 font-semibold text-sidebar-accent-foreground"
          href={item.href}
          key={item.href}
          aria-current="page"
        >
          {item.label}
        </a>
      ))}
      {plannedNavigation.map((label) => (
        <span
          aria-disabled="true"
          className="block cursor-not-allowed rounded-lg px-3 py-2.5 text-muted-foreground"
          key={label}
        >
          {label}
          <span className="sr-only"> (coming soon)</span>
        </span>
      ))}
    </nav>
  );
}

function ProductHeader(): ReactNode {
  return (
    <header className="flex min-h-18 items-center justify-between border-b border-border bg-card px-5 lg:px-8">
      <div className="lg:hidden">
        <a aria-label="Snackday app overview" href="/app">
          <Brand />
        </a>
      </div>
      <div className="hidden lg:block">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Team workspace
        </p>
        <p className="font-bold">Your team</p>
      </div>
      <details className="relative lg:hidden">
        <summary className="cursor-pointer list-none rounded-lg border border-border px-4 py-2 font-semibold">
          Workspace menu
        </summary>
        <div className="absolute right-0 top-12 z-20 w-64 rounded-xl border border-border bg-card p-3 shadow-lg">
          <ProductNavigation />
        </div>
      </details>
      <span className="hidden rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground sm:inline">
        Account setup pending
      </span>
    </header>
  );
}

export default function AppLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh bg-muted/40 lg:grid lg:grid-cols-[17rem_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar p-5 lg:flex lg:flex-col">
        <a aria-label="Snackday app overview" href="/app">
          <Brand />
        </a>
        <div className="mt-8 rounded-xl border border-sidebar-border bg-background p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Team workspace
          </p>
          <p className="mt-1 font-bold">Your team</p>
          <p className="text-sm text-muted-foreground">Season setup</p>
        </div>
        <div className="mt-6">
          <ProductNavigation />
        </div>
        <div className="mt-auto border-t border-sidebar-border pt-5">
          <p className="text-sm font-semibold">Account</p>
          <p className="text-xs text-muted-foreground">Available after sign-in</p>
        </div>
      </aside>
      <div className="min-w-0">
        <ProductHeader />
        {/* Identity owns the future app/middleware.ts guard. This shell is not an authorization boundary. */}
        <main className="mx-auto max-w-7xl p-5 lg:p-8" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
