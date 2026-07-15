import type { ReactNode } from "react";

import { LoadingState } from "../../components/states/loading-state";

export default function AppLoading(): ReactNode {
  return <LoadingState label="Loading team workspace" />;
}
