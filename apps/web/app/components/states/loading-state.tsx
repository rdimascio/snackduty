import type { ReactNode } from "react";

export function LoadingState({ label = "Loading your team" }: { label?: string }): ReactNode {
  return (
    <section aria-busy="true" aria-label={label} className="space-y-4" role="status">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-3">
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      </div>
    </section>
  );
}
