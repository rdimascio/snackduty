import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="min-h-dvh bg-background text-foreground" data-app-shell>
      <a
        className="fixed left-4 top-4 z-50 -translate-y-24 rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-lg transition-transform focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      {children}
    </div>
  );
}
