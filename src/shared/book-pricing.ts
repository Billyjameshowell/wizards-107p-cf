import { roundMoney, vsSeason, type Book, type Game } from "./book";
import { seatPriceForGame, type ModelAsk } from "./pricing";

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
 * Fill each game's keep-per-seat (advised_ask) and pair cash from his live
 * listing price, else the price model's ask, else the sold amount. Season cash
 * (sell_book_cash) is money already in from sold pairs; planned_sell_cash adds
 * the unsold Sell games at those prices.
 *
 * modelAsks is the trends step's saved ask per game date. When it is given it
 * replaces every game's model_* fields (a game the model did not price gets
 * none); when it is omitted the fields already on the book are kept.
 */
export function priceBook(
  book: Book,
  todayEt: string,
  modelAsks?: Readonly<Record<string, ModelAsk>>,
): Book {
  let banked = 0;
  let planned = 0;
  const games = book.games.map((input) => {
    const game = modelAsks ? withModelAsk(input, modelAsks[input.date] ?? null) : input;
    const sold = soldKeepTotalOf(game);
    if (sold != null) {
      banked += sold;
      planned += sold;
      return { ...game, advised_ask: roundMoney(sold / 2), cash_both_after_fee: sold };
    }
    if (game.sold || (game.date < todayEt && game.sit_or_sell === "Sell")) {
      // Sold with no amount on file, or played and never sold: no cash to project.
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

function withModelAsk(game: Game, model: ModelAsk | null): Game {
  return {
    ...game,
    model_ask: model?.ask ?? null,
    model_sale_chance: model?.chance ?? null,
    model_expected: model?.expected ?? null,
  };
}
