import { describe, expect, it } from "vitest";
import seed from "../data/seed-book.json";
import {
  cashBothAfterFee,
  goingAskFromListings,
  isCompListing,
  keepFromTypeIn,
  recomputeBookTotals,
  sellerFeePerSeat,
  sellBookCash,
  typeInFromKeep,
  vsSeason,
  type Book,
} from "@shared/book";

describe("seed book", () => {
  it("ships 43 home games with sit/sell and no auto-list", () => {
    const book = seed as Book;
    expect(book.games).toHaveLength(43);
    expect(book.season_cost).toBe(6000);
    expect(book.section).toBe("107");
    expect(book.row).toBe("P");
    expect(book.seats).toEqual([1, 2]);
    expect(book.list_nothing_until_billy_says).toBe(true);
    expect(book.games.every((game) => game.listed === false && game.sold === false)).toBe(true);
  });
});

describe("money", () => {
  it("keeps 95% of the typed Set Your Price, matching the $49 payout modal", () => {
    expect(sellerFeePerSeat(49)).toBe(2.45);
    expect(keepFromTypeIn(49)).toBe(46.55);
    expect(cashBothAfterFee(49)).toBe(93.1);
    expect(typeInFromKeep(46.55)).toBe(49);
    expect(cashBothAfterFee(null)).toBeNull();
  });

  it("does not turn a stored ask into pair cash", () => {
    const book = recomputeBookTotals({
      ...(seed as Book),
      games: [
        {
          ...(seed as Book).games[0],
          sit_or_sell: "Sell",
          advised_ask: 100,
          cash_both_after_fee: 180,
        },
      ],
    });
    expect(book.games[0]?.cash_both_after_fee).toBeNull();
    expect(book.sell_book_cash).toBe(0);
  });

  it("sums sell-book cash and the gap vs $6k", () => {
    const book = recomputeBookTotals(seed as Book);
    expect(book.sell_book_cash).toBe(sellBookCash(book.games));
    expect(book.vs_6k).toBe(vsSeason(book.sell_book_cash, 6000));
    expect(book.vs_6k).toBeLessThan(0);
  });
});

describe("comp filter 107/108/118/119 J–T", () => {
  it("takes the lowest active pair in the target pocket", () => {
    const ask = goingAskFromListings([
      { active: true, section: "107", row: "P", quantity: 2, price: 180 },
      { active: true, section: "108", row: "K", quantity: 2, price: 165 },
      { active: true, section: "119", row: "T", quantity: 4, price: 210 },
      { active: true, section: "216", row: "P", quantity: 2, price: 40 },
      { active: true, section: "107", row: "A", quantity: 2, price: 90 },
      { active: false, section: "107", row: "P", quantity: 2, price: 50 },
      { active: true, section: "107", row: "P", quantity: 1, price: 70 },
    ]);
    expect(ask).toBe(165);
  });

  it("rejects listings outside the pocket", () => {
    expect(
      isCompListing({ active: true, section: "Lower 216", row: "P", quantity: 2, price: 10 }),
    ).toBe(false);
    expect(
      isCompListing({ active: true, section: "Lower 107", row: "P", quantity: 2, price: 10 }),
    ).toBe(true);
  });
});
