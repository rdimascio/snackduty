import type { PageDef } from "@lesto/web";

import type { PlayerCardData } from "./sample-player";

export const BALLPLAYER_APP_PAGE_PATH = "/__ballplayer/app";

export type BallplayerAppPath = typeof BALLPLAYER_APP_PAGE_PATH;

export type BallplayerCardEntry = PlayerCardData & { readonly participantId: string };

export type BallplayerAppData =
  | { readonly state: "unavailable" }
  | { readonly state: "signed-out"; readonly devSignIn: boolean }
  | { readonly state: "cards-off"; readonly adultName: string }
  | { readonly state: "error"; readonly adultName: string }
  | { readonly state: "empty"; readonly adultName: string }
  | {
      readonly state: "cards";
      readonly adultName: string;
      readonly cards: readonly BallplayerCardEntry[];
      readonly readOnly: boolean;
    };

export type BallplayerAppPage = PageDef<BallplayerAppPath, BallplayerAppData>;

export interface BallplayerAppModule {
  readonly ballplayerApp: BallplayerAppPage;
}
