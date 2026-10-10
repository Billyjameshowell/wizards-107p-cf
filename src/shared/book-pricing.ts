import { roundMoney, vsSeason, type Book, type Game } from "./book";
import { seatPriceForGame } from "./pricing";

/** What a sold pair actually brought, or null if it is not sold with a known amount. */
export function soldKeepTotalOf(game: Pick<Game, "sold" | "sold_keep_total">): number | null {
  if (!game.sold) return null;
  const value = game.sold_keep_total;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? roundMoney(value) : null;
}

/** The type-in the price view should start from: his saved one, else his listing (live or sold). */
export function startingTypeIn(
  game: Pick<Game, "listed" | "listed_ask"> & { sold?: boolean },
  savedTypeIn: number | null,
): number | null {
  if (savedTypeIn != null && savedTypeIn > 0) return savedTypeIn;
  if ((game.listed || game.sold === true) && typeof game.listed_ask === "number" && game.listed_ask > 0) {
    return game.listed_ask;
  }
  return null;
}

/**
 * Fill each game's keep-per-seat (advised_ask) and pair cash from the newest
 * comps, or from his live listing price, or from the sold amount. Season cash
 * (sell_book_cash) is money already in from sold pairs; planned_sell_cash adds
 * the unsold Sell games at today's prices.
 */
export function priceBook(book: Book, todayEt: string): Book {
  let banked = 0;
  let planned = 0;
  const games = book.games.map((game) => {
    const sold = soldKeepTotalOf(game);
    if (sold != null) {
      banked += sold;
      planned += sold;
      return { ...game, advised_ask: roundMoney(sold / 2), cash_both_after_fee: sold };
    }
    if (game.sold) {
      // Sold with no amount on file: never show a guess as his cash.
      return { ...game, advised_ask: null, cash_both_after_fee: null };
    }
    const view = seatPriceForGame(game, startingTypeIn(game, null), todayEt);
    if (game.sit_or_sell === "Sell" && view.pair != null) planned += view.pair;
    return { ...game, advised_ask: view.keep, cash_both_after_fee: view.pair };
  });
  const sell_book_cash = roundMoney(banked);
  return {
    ...book,
    games,
    sell_book_cash,
    planned_sell_cash: roundMoney(planned),
    vs_6k: vsSeason(sell_book_cash, book.season_cost),
  };
}
