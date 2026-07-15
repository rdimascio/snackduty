import type { ReactNode } from "react";

import { LoadingState } from "../components/states/loading-state";

export default function Loading(): ReactNode {
  return (
    <main className="mx-auto max-w-7xl px-5 py-20" id="main-content">
      <LoadingState label="Loading Snackday" />
    </main>
  );
}
