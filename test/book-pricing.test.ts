import { describe, expect, it } from "vitest";
import seed from "../data/seed-book.json";
import type { Book, Game } from "../src/shared/book";
import { priceBook, soldKeepTotalOf, startingTypeIn } from "../src/shared/book-pricing";
import { seatPriceForGame } from "../src/shared/pricing";

const base = (seed as Book).games[0] as Game;

function game(over: Partial<Game>): Game {
  return {
    ...base,
    date: "2026-10-21",
    sit_or_sell: "Sell",
    advised_ask: 87.13,
    cash_both_after_fee: null,
    listed: false,
    listed_ask: null,
    sold: false,
    comp_median: 217.16,
    comp_count: 278,
    comp_pulls: 1,
    comp_confidence: "thin",
    comp_held_prior: false,
    comp_snapshot_median: 217.16,
    ...over,
  };
}

function book(games: Game[]): Book {
  return { ...(seed as Book), sell_book_cash: 0, vs_6k: -6000, season_cost: 6000, games };
}

describe("priceBook", () => {
  it("replaces a stale stored ask with the price model's ask", () => {
    const g = game({});
    const asks = { "2026-10-21": { ask: 206, chance: 0.71, expected: 277.9 } };
    const out = priceBook(book([g]), "2026-10-10", asks);
    const priced = out.games[0]!;
    const view = seatPriceForGame(priced, null, "2026-10-10");
    expect(priced.model_ask).toBe(206);
    expect(priced.model_sale_chance).toBe(0.71);
    expect(view.typeIn).toBe(206);
    expect(priced.advised_ask).toBe(view.keep);
    expect(priced.cash_both_after_fee).toBe(view.pair);
    expect(priced.advised_ask).not.toBe(87.13);
  });

  it("drops a model ask the trends step no longer has, and keeps the stored one when no asks are given", () => {
    const g = game({ model_ask: 150, model_sale_chance: 0.7 });
    expect(priceBook(book([g]), "2026-10-10", {}).games[0]?.advised_ask).toBeNull();
    expect(priceBook(book([g]), "2026-10-10").games[0]?.advised_ask).toBe(142.5);
  });

  it("uses his live listing price for keep amounts", () => {
    const out = priceBook(book([game({ listed: true, listed_ask: 83 })]), "2026-10-10");
    expect(out.games[0]?.advised_ask).toBe(78.85);
    expect(out.games[0]?.cash_both_after_fee).toBe(157.7);
  });

  it("counts only sold pairs as season cash", () => {
    const out = priceBook(
      book([
        game({ date: "2026-10-10", sold: true, listed: false, listed_ask: 30, sold_keep_total: 57 }),
        game({}),
        game({ date: "2026-11-01", sit_or_sell: "Sit" }),
      ]),
      "2026-10-10",
      {
        "2026-10-21": { ask: 206, chance: 0.71, expected: 277.9 },
        "2026-11-01": { ask: 120, chance: 0.7, expected: 159.6 },
      },
    );
    expect(out.sell_book_cash).toBe(57);
    expect(out.vs_6k).toBe(-5943);
    expect(out.games[0]?.advised_ask).toBe(28.5);
    expect(out.games[0]?.cash_both_after_fee).toBe(57);
    expect(out.planned_sell_cash).toBe(57 + (out.games[1]?.cash_both_after_fee ?? 0));
    expect(out.games[2]?.cash_both_after_fee).not.toBeNull();
  });

  it("never guesses cash for a sold pair with no amount", () => {
    const out = priceBook(book([game({ sold: true })]), "2026-10-10");
    expect(out.games[0]?.cash_both_after_fee).toBeNull();
    expect(out.sell_book_cash).toBe(0);
  });
});

describe("helpers", () => {
  it("prefers a saved type-in over the listing price", () => {
    expect(startingTypeIn({ listed: true, listed_ask: 83 }, 90)).toBe(90);
    expect(startingTypeIn({ listed: true, listed_ask: 83 }, null)).toBe(83);
    expect(startingTypeIn({ listed: false, listed_ask: 83 }, null)).toBeNull();
    expect(startingTypeIn({ listed: false, sold: true, listed_ask: 30 }, null)).toBe(30);
    expect(soldKeepTotalOf({ sold: false, sold_keep_total: 57 })).toBeNull();
    expect(soldKeepTotalOf({ sold: true, sold_keep_total: 57 })).toBe(57);
  });
});
