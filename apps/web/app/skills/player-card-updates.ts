import type { PlayerCardArea, PlayerCardEntry } from "./player-card";

export const PLAYER_CARD_UPDATED = "snackday:player-card-updated";

export interface PlayerCardUpdate {
  readonly participantId: string;
  readonly overall: number;
  readonly areas: readonly PlayerCardArea[];
}

export type CardGetter = (url: string) => Promise<{ ok: boolean; json: unknown }>;

export interface PlayerCardRefreshOptions {
  readonly get?: CardGetter;
  readonly target?: EventTarget;
}

interface CardResponse {
  readonly overall: number;
  readonly areas: readonly { readonly area: string; readonly rating: number }[];
}

async function getJson(url: string) {
  const response = await fetch(url, { credentials: "same-origin" });
  return { ok: response.ok, json: response.ok ? ((await response.json()) as unknown) : undefined };
}

function isCardResponse(value: unknown): value is CardResponse {
  if (typeof value !== "object" || value === null) return false;
  const { overall, areas } = value as Partial<Record<keyof CardResponse, unknown>>;
  return (
    typeof overall === "number" &&
    Array.isArray(areas) &&
    areas.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { area?: unknown }).area === "string" &&
        typeof (entry as { rating?: unknown }).rating === "number",
    )
  );
}

function windowTarget(): EventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function skillCardUrl(teamId: string, participantId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/participants/${encodeURIComponent(participantId)}/skill-card`;
}

export async function fetchPlayerCardUpdate(
  teamId: string,
  participantId: string,
  get: CardGetter = getJson,
): Promise<PlayerCardUpdate | undefined> {
  const response = await get(skillCardUrl(teamId, participantId));
  if (!response.ok || !isCardResponse(response.json)) return undefined;
  return {
    participantId,
    overall: response.json.overall,
    areas: response.json.areas.map(({ area, rating }) => ({ area, rating })),
  };
}

export function publishPlayerCardUpdate(
  update: PlayerCardUpdate,
  target: EventTarget | undefined = windowTarget(),
): void {
  target?.dispatchEvent(new CustomEvent(PLAYER_CARD_UPDATED, { detail: update }));
}

export function subscribePlayerCardUpdates(
  listener: (update: PlayerCardUpdate) => void,
  target: EventTarget | undefined = windowTarget(),
): () => void {
  const handle = (event: Event) => {
    if (event instanceof CustomEvent) listener(event.detail as PlayerCardUpdate);
  };
  target?.addEventListener(PLAYER_CARD_UPDATED, handle);
  return () => target?.removeEventListener(PLAYER_CARD_UPDATED, handle);
}

export function applyPlayerCardUpdate(
  players: readonly PlayerCardEntry[],
  update: PlayerCardUpdate,
): PlayerCardEntry[] {
  return players.map((player) =>
    player.participantId === update.participantId
      ? { ...player, overall: update.overall, areas: update.areas }
      : player,
  );
}

export async function refreshPlayerCard(
  teamId: string,
  participantId: string,
  options: PlayerCardRefreshOptions = {},
): Promise<PlayerCardUpdate | undefined> {
  try {
    const update = await fetchPlayerCardUpdate(teamId, participantId, options.get);
    if (update !== undefined) publishPlayerCardUpdate(update, options.target ?? windowTarget());
    return update;
  } catch {
    return undefined;
  }
}
