import type { ReactNode } from "react";

/** Wrap every file-routed page in a shared shell — the convention's root layout. */
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return <div data-app-shell>{children}</div>;
}
