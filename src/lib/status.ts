import type { Game, ListingOverride, ListingStatusMap } from "@shared/book";

export const LOCAL_STATUS_KEY = "wizards-107p-listing-status";

export function emptyOverride(game: Game): ListingOverride {
  return {
    listed: game.listed,
    sold: game.sold,
    listed_ask: game.listed_ask,
    notes: game.notes ?? "",
  };
}

export function mergeGameStatus(
  game: Game,
  repoStatus: ListingStatusMap,
  localStatus: ListingStatusMap,
): ListingOverride {
  return {
    ...emptyOverride(game),
    ...repoStatus[game.date],
    ...localStatus[game.date],
  };
}

export function readLocalStatus(): ListingStatusMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_STATUS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as ListingStatusMap;
  } catch {
    return {};
  }
}

export function writeLocalStatus(map: ListingStatusMap): void {
  window.localStorage.setItem(LOCAL_STATUS_KEY, JSON.stringify(map));
}

export function buildExportMap(
  games: Game[],
  repoStatus: ListingStatusMap,
  localStatus: ListingStatusMap,
): ListingStatusMap {
  const next: ListingStatusMap = {};
  for (const game of games) {
    const merged = mergeGameStatus(game, repoStatus, localStatus);
    const base = emptyOverride(game);
    const changed =
      merged.listed !== base.listed ||
      merged.sold !== base.sold ||
      merged.listed_ask !== base.listed_ask ||
      merged.notes !== base.notes;
    if (changed) {
      next[game.date] = merged;
    }
  }
  return next;
}
