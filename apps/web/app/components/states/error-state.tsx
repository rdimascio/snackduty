import type { ReactNode } from "react";

import { ButtonLink } from "../ui/button";

export function ErrorState({
  title = "Something went sideways",
  description = "We couldn't load this page. Try again, or head back to a safe place.",
  href = "/",
}: {
  title?: string;
  description?: string;
  href?: string;
}): ReactNode {
  return (
    <section
      className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center shadow-sm"
      role="alert"
    >
      <p className="text-sm font-bold uppercase tracking-widest text-destructive">We hit a snag</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">{title}</h1>
      <p className="mt-3 leading-7 text-muted-foreground">{description}</p>
      <ButtonLink className="mt-6" href={href}>
        Try a fresh start
      </ButtonLink>
    </section>
  );
}
