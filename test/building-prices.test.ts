import { describe, expect, it } from "vitest";
import type { Game } from "@shared/book";
import { buildingPrices, centralColumnLabel } from "@/lib/building-prices";

function game(partial: Partial<Game> & Record<string, unknown> = {}): Game {
  return {
    date: "2026-10-21",
    weekday: "Wed",
    time_et: "7:00 PM",
    opponent: "Milwaukee Bucks",
    type: "regular",
    sit_or_sell: "Sit",
    advised_ask: null,
    cash_both_after_fee: null,
    listed: false,
    listed_ask: null,
    sold: false,
    notes: "",
    ticketdata_url: null,
    ...partial,
  } as Game;
}

describe("buildingPrices", () => {
  it("reads stored get-in and prefers median over mean", () => {
    const prices = buildingPrices(
      game({
        market_get_in: 80,
        market_median: 140,
        market_mean: 200,
      }),
    );
    expect(prices).toEqual({ getIn: 80, central: 140, centralKind: "median" });
  });

  it("labels a mean-only game as mean and still shows get-in", () => {
    const onlyMean = game({ market_get_in: 55, market_mean: 90 });
    expect(buildingPrices(onlyMean)).toEqual({ getIn: 55, central: 90, centralKind: "mean" });
    expect(centralColumnLabel([onlyMean])).toBe("Mean");
  });

  it("leaves the central price blank when only get-in was stored", () => {
    const prices = buildingPrices(game({ market_get_in: 42 }));
    expect(prices.getIn).toBe(42);
    expect(prices.central).toBeNull();
    expect(prices.centralKind).toBeNull();
    expect(centralColumnLabel([game({ market_get_in: 42 })])).toBe("Median");
  });

  it("falls back to arena snapshot and alias fields already on a book", () => {
    const fromDetails = buildingPrices(
      game({
        market_details: { get_in: 70, median: 110, mean: 130 },
      }),
    );
    expect(fromDetails).toEqual({ getIn: 70, central: 110, centralKind: "median" });

    const aliases = buildingPrices(
      game({
        live_get_in: 64,
        jt_median: 99,
      }),
    );
    expect(aliases).toEqual({ getIn: 64, central: 99, centralKind: "median" });
  });
});
