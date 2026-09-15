export type SitOrSell = "Sit" | "Sell" | "TBD";

export type Game = {
  date: string;
  weekday: string;
  time_et: string;
  opponent: string;
  type: string;
  sit_or_sell: SitOrSell | string;
  advised_ask: number | null;
  cash_both_after_fee: number | null;
  listed: boolean;
  listed_ask: number | null;
  sold: boolean;
  notes: string;
  ticketdata_url: string | null;
  market_get_in?: number | null;
  market_median?: number | null;
  listing_count?: number | null;
};

export type Book = {
  asof_et: string;
  sell_book_cash: number;
  vs_6k: number;
  season_cost: number;
  section: string;
  row: string;
  seats: number[];
  list_nothing_until_billy_says: boolean;
  games: Game[];
};

export type ListingOverride = {
  listed: boolean;
  sold: boolean;
  listed_ask: number | null;
  notes: string;
};

export type ListingStatusMap = Record<string, ListingOverride>;

export type FilterId =
  | "all"
  | "sit"
  | "sell"
  | "not-listed"
  | "listed"
  | "sold";

export const SEASON_COST_DEFAULT = 6000;
export const TICKETMASTER_FEE_RATE = 0.1;
export const PAIR_SEATS = 2;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function cashBothAfterFee(
  ask: number | null | undefined,
  feeRate = TICKETMASTER_FEE_RATE,
): number | null {
  if (ask == null || Number.isNaN(ask)) return null;
  return roundMoney(ask * PAIR_SEATS * (1 - feeRate));
}

export function sellBookCash(games: Game[]): number {
  return roundMoney(
    games
      .filter((game) => game.sit_or_sell === "Sell" && game.cash_both_after_fee != null)
      .reduce((sum, game) => sum + (game.cash_both_after_fee ?? 0), 0),
  );
}

export function vsSeason(sellCash: number, seasonCost: number): number {
  return roundMoney(sellCash - seasonCost);
}

export function recomputeBookTotals(book: Book): Book {
  const games = book.games.map((game) => ({
    ...game,
    cash_both_after_fee: cashBothAfterFee(game.advised_ask),
  }));
  const sell_book_cash = sellBookCash(games);
  return {
    ...book,
    games,
    sell_book_cash,
    vs_6k: vsSeason(sell_book_cash, book.season_cost),
  };
}

export type CompListing = {
  active?: boolean | number;
  section?: string;
  row?: string;
  quantity?: number;
  price?: number;
};

export const COMP_SECTIONS = ["107", "108", "118", "119"] as const;
export const COMP_ROWS = ["J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"] as const;

export function extractSectionNumber(section: string | undefined): string | null {
  if (!section) return null;
  const match = section.match(/\d{3}/);
  return match?.[0] ?? null;
}

export function normalizeRow(row: string | undefined): string | null {
  if (!row) return null;
  const match = row.trim().toUpperCase().match(/[A-Z]/);
  return match?.[0] ?? null;
}

export function isCompListing(listing: CompListing): boolean {
  const active = listing.active === true || listing.active === 1;
  if (!active) return false;
  const qty = listing.quantity ?? 0;
  if (qty < PAIR_SEATS) return false;
  const section = extractSectionNumber(listing.section);
  const row = normalizeRow(listing.row);
  if (!section || !row) return false;
  return (
    (COMP_SECTIONS as readonly string[]).includes(section) &&
    (COMP_ROWS as readonly string[]).includes(row)
  );
}

export function goingAskFromListings(listings: CompListing[]): number | null {
  const prices = listings
    .filter(isCompListing)
    .map((listing) => listing.price)
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price) && price > 0);
  if (prices.length === 0) return null;
  return roundMoney(Math.min(...prices));
}

export function formatEtStamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const month = get("month").padStart(2, "0");
  const day = get("day").padStart(2, "0");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod").toLowerCase().replace(/\./g, "");
  return `${get("year")}-${month}-${day} ${hour}:${minute}${dayPeriod}`;
}
