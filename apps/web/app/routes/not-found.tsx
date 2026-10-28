import type { ReactNode } from "react";

import { ErrorState } from "../components/states/error-state";

export function NotFoundState(): ReactNode {
  return (
    <ErrorState
      title="That page isn't on the roster"
      description="The page may have moved, or the address may be incomplete."
    />
  );
}

export default function NotFound(): ReactNode {
  return (
    <main className="px-5 py-20" id="main-content">
      <NotFoundState />
    </main>
  );
}
