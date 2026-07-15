import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/utils";

type ButtonLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: "primary" | "secondary" | "ghost";
};

const variants = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  secondary: "border border-border bg-card text-card-foreground shadow-sm hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
} as const;

export function ButtonLink({
  className,
  variant = "primary",
  ...props
}: ButtonLinkProps): ReactNode {
  return (
    <a
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
