import type { ReactNode } from "react";

import { Brand } from "../../components/brand";
import { ButtonLink } from "../../components/ui/button";

const navigation = [
  { href: "/", label: "Home" },
  { href: "/features", label: "Features" },
] as const;

export default function MarketingLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border/70 bg-background/95">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 lg:px-8">
          <a aria-label="Snackday home" href="/">
            <Brand />
          </a>
          <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
            {navigation.map((item) => (
              <ButtonLink href={item.href} key={item.href} variant="ghost">
                {item.label}
              </ButtonLink>
            ))}
            <ButtonLink className="ml-2" href="/app">
              Open Snackday
            </ButtonLink>
          </nav>
          <details className="relative sm:hidden">
            <summary className="cursor-pointer list-none rounded-lg border border-border px-4 py-2 font-semibold">
              Menu
            </summary>
            <nav
              aria-label="Mobile primary"
              className="absolute right-0 top-12 z-20 flex w-56 flex-col gap-1 rounded-xl border border-border bg-card p-2 shadow-lg"
            >
              {navigation.map((item) => (
                <ButtonLink href={item.href} key={item.href} variant="ghost">
                  {item.label}
                </ButtonLink>
              ))}
              <ButtonLink href="/app">Open Snackday</ButtonLink>
            </nav>
          </details>
        </div>
      </header>
      <main className="flex-1" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <Brand className="text-foreground" />
          <p>Built for the families who make youth sports happen.</p>
        </div>
      </footer>
    </div>
  );
}
