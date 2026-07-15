import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <section
      aria-labelledby="empty-state-title"
      className="rounded-2xl border border-dashed border-border bg-card p-8 text-center"
    >
      <div
        aria-hidden="true"
        className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-accent text-xl"
      >
        ✦
      </div>
      <h2 className="text-lg font-bold" id="empty-state-title">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </section>
  );
}
