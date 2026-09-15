import { describe, expect, it } from "vitest";
import seed from "../data/seed-book.json";
import {
  cashBothAfterFee,
  goingAskFromListings,
  isCompListing,
  recomputeBookTotals,
  sellBookCash,
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
  it("applies the ~10% Ticketmaster fee to both seats", () => {
    expect(cashBothAfterFee(235.24)).toBe(423.43);
    expect(cashBothAfterFee(null)).toBeNull();
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
