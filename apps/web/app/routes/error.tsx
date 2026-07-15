import type { ReactNode } from "react";

import { ErrorState } from "../components/states/error-state";

export default function ErrorBoundary(): ReactNode {
  return (
    <main className="px-5 py-20" id="main-content">
      <ErrorState />
    </main>
  );
}
