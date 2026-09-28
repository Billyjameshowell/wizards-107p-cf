import type { Game } from "@shared/book";

export type CentralPriceKind = "median" | "mean";

export type BuildingPrices = {
  getIn: number | null;
  central: number | null;
  centralKind: CentralPriceKind | null;
};

function asMoney(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function stored(game: Game, key: string): unknown {
  return (game as Game & Record<string, unknown>)[key];
}

function detail(game: Game, key: string): unknown {
  const snapshot = stored(game, "market_details");
  if (!snapshot || typeof snapshot !== "object") return undefined;
  return (snapshot as Record<string, unknown>)[key];
}

function firstMoney(values: unknown[]): number | null {
  for (const value of values) {
    const money = asMoney(value);
    if (money != null) return money;
  }
  return null;
}

/** Arena get-in plus median (or mean, when that is all the book stored). */
export function buildingPrices(game: Game): BuildingPrices {
  const getIn = firstMoney([
    game.market_get_in,
    detail(game, "get_in"),
    stored(game, "get_in"),
    stored(game, "live_get_in"),
  ]);
  const median = firstMoney([
    game.market_median,
    detail(game, "median"),
    stored(game, "median"),
    stored(game, "jt_median"),
  ]);
  const mean = firstMoney([
    stored(game, "market_mean"),
    detail(game, "mean"),
    stored(game, "mean"),
  ]);
  if (median != null) return { getIn, central: median, centralKind: "median" };
  if (mean != null) return { getIn, central: mean, centralKind: "mean" };
  return { getIn, central: null, centralKind: null };
}

export function centralColumnLabel(games: readonly Game[]): "Median" | "Mean" {
  let sawMean = false;
  for (const game of games) {
    const prices = buildingPrices(game);
    if (prices.centralKind === "median") return "Median";
    if (prices.centralKind === "mean") sawMean = true;
  }
  return sawMean ? "Mean" : "Median";
}
