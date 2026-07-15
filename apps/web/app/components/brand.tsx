import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function Brand({ className }: { className?: string }): ReactNode {
  return (
    <span className={cn("inline-flex items-center gap-2 font-bold tracking-tight", className)}>
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-xl bg-primary text-lg text-primary-foreground shadow-sm"
      >
        S
      </span>
      <span>Snackday</span>
    </span>
  );
}
