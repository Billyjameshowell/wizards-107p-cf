export type SitOrSell = "Sit" | "Sell" | "TBD";

export type Game = {
  date: string;
  weekday: string;
  time_et: string;
  opponent: string;
  type: string;
  sit_or_sell: SitOrSell | string;
  advised_ask: number | null;
  /** Pair cash is computed in the browser from the type-in he is using. */
  cash_both_after_fee: number | null;
  /** Middle of serious 107/108/118/119 rows J–T listings, after the cheap 107P dump rule. */
  comp_median?: number | null;
  comp_count?: number | null;
  comp_excluded_dump?: boolean;
  /** "bigger" | "soft" | "standard" when a game is actually marked. Absent means no tier. */
  demand?: string | null;
  listed: boolean;
  listed_ask: number | null;
  sold: boolean;
  notes: string;
  ticketdata_url: string | null;
  market_get_in?: number | null;
  market_median?: number | null;
  market_mean?: number | null;
  listing_count?: number | null;
  market_details?: {
    get_in?: number | null;
    median?: number | null;
    mean?: number | null;
  } | null;
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
/**
 * Seller service fee observed on the Wizards Account Manager payout modal
 * (Preseason vs Nets, Mon Oct 12 2026, Sec 107 Row P seats 1–2):
 * typed “Set Your Price Per Ticket” $49.00, seller fee −$2.45 (exactly 5%),
 * payout $46.55 a seat, both seats $93.10.
 * The modal also says the buyer sees a higher price. That buyer total is not
 * in the modal, so this book does not invent one.
 * He keeps 95% of the number he types. Pair cash = 2 × that keep.
 */
export const SELLER_FEE_RATE = 0.05;
export const SELLER_KEEP_RATE = 0.95;
export const PAIR_SEATS = 2;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What he keeps for one seat after the 5% seller fee on a typed price. */
export function keepFromTypeIn(typeIn: number): number {
  return Math.round(typeIn * 95) / 100;
}

/** Seller fee for one seat. $49 → $2.45. */
export function sellerFeePerSeat(typeIn: number): number {
  return Math.round(typeIn * 5) / 100;
}

/** Both seats: 2 × keep = typed price × 1.90. $49 → $93.10. */
export function pairFromTypeIn(typeIn: number): number {
  return Math.round(typeIn * 190) / 100;
}

/**
 * Whole-dollar “Set Your Price” whose 95% payout is closest to `keep`.
 * Halfway cases round up ($52.50 → $53), so the payout is the nearer keep
 * and, on an exact tie, the higher typed dollar.
 */
export function typeInFromKeep(keep: number): number {
  if (!Number.isFinite(keep) || keep <= 0) return 1;
  const typeIn = Math.round(keep / SELLER_KEEP_RATE);
  return typeIn < 1 ? 1 : typeIn;
}

export function cashBothAfterFee(
  ask: number | null | undefined,
  feeRate = SELLER_FEE_RATE,
): number | null {
  if (ask == null || Number.isNaN(ask)) return null;
  if (feeRate === SELLER_FEE_RATE) return pairFromTypeIn(ask);
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
    // Do not turn a stored ask into cash with a flat haircut. Pair cash is
    // 2 × what he keeps, and that depends on the type-in he saved or the
    // live suggestion. The browser owns that number.
    cash_both_after_fee: null,
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
