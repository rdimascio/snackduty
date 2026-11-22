import type { ReactNode } from "react";

import { coachTitle } from "./content";

export function CoachShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh bg-field text-chalk" data-app-shell data-brand="coach">
      <main className="mx-auto max-w-2xl px-6 py-20 lg:px-10" id="main-content">
        <a className="text-sm font-bold tracking-[0.2em] text-clay uppercase" href="/">
          {coachTitle}
        </a>
        {children}
      </main>
    </div>
  );
}
