import {
  extractSectionNumber,
  isCompListing,
  keepFromTypeIn,
  normalizeRow,
  pairFromTypeIn,
  roundMoney,
  type CompListing,
  type Game,
} from "./book";
import { compHistoryNote, type CompConfidence } from "./price-history";

/**
 * Pricing for Billy’s Section 107 Row P seats 1–2.
 *
 * Fee (from the Account Manager modal, not a guessed buyer fee):
 * he keeps 95% of the whole-dollar number he types in “Set Your Price Per Ticket.”
 * Pair cash = 2 × that keep. The buyer pays more than the typed price.
 * This book does not know that buyer total.
 *
 * Public comps:
 * SeatData `listing.price` and the arena get-in / median fields are plain numbers.
 * Nothing in the stored book says whether a comp is a seller’s typed price or a
 * buyer’s all-in price. The suggestion therefore shows that middle as
 * “listed around” and turns it into a type-in / you-keep pair using only the 5%
 * seller fee. It does not invent a buyer markup.
 *
 * The middle is the blended SeatData band, not the arena median. Recent checks
 * count more. It is shown next to the ask for context.
 *
 * The suggested type-in is the price model's ask (src/shared/price-model.ts,
 * built by the daily trends step from the comps archive): the ask with the most
 * expected cash after the sale chance, leaned once toward the season goal. The
 * book, the trends page and the grid all read that one ask. A number he typed is
 * still never replaced.
 *
 * A saved type-in is any whole dollar he chose. It is never passed through
 * this rounding, and it is never replaced when days or comps change.
 */

export type Demand = "bigger" | "soft" | "standard";

export type CompMedian = {
  median: number | null;
  count: number;
  excludedDump: boolean;
};

/** The price model's ask for one game, as the trends step saved it. */
export type ModelAsk = {
  ask: number;
  /** Chance it sells before tip at that ask. */
  chance: number | null;
  /** Expected pair cash after the fee at that ask. */
  expected: number | null;
};

export type Suggestion = {
  typeIn: number;
  keep: number;
  pair: number;
  /** The blended comp middle, for context. Null before the first comps. */
  listedMedian: number | null;
  compCount: number | null;
  excludedDump: boolean;
  saleChance: number | null;
  label: string;
  daysOut: number | null;
  /** This morning had no usable comps. The middle is from recent checks. */
  heldPrior: boolean;
  /** Quiet explanation once more than one check is saved. */
  historyNote: string | null;
};

export type SeatPriceView = {
  typeIn: number | null;
  keep: number | null;
  pair: number | null;
  savedTypeIn: number | null;
  hasSaved: boolean;
  usingOwn: boolean;
  suggestion: Suggestion | null;
  emptyNote: string | null;
};

/** Nearest whole dollar. Halves round up for positive prices. */
export function roundDollar(value: number): number {
  return Math.round(value);
}

export function etYmd(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function daysUntil(gameDate: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const game = Date.parse(`${gameDate}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(game) || Number.isNaN(start)) return null;
  return Math.round((game - start) / 86_400_000);
}

export function formatDaysOut(days: number): string {
  if (days === 0) return "Tip is today";
  if (days === 1) return "Tip is tomorrow";
  if (days > 1) return `${days} days out`;
  if (days === -1) return "Tip was yesterday";
  return `Tip was ${Math.abs(days)} days ago`;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function is107RowP(listing: CompListing): boolean {
  return extractSectionNumber(listing.section) === "107" && normalizeRow(listing.row) === "P";
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left == null || right == null) return null;
  return (left + right) / 2;
}

/**
 * Middle of serious listings in 107 / 108 / 118 / 119, rows J–T, quantity ≥ 2.
 * If one listing is strictly the cheapest and it is Section 107 Row P, leave
 * that single dump out. A floor shared by two listings stays in.
 */
export function seriousCompMedian(listings: CompListing[]): CompMedian {
  const serious = listings.filter((listing) => {
    if (!isCompListing(listing)) return false;
    return typeof listing.price === "number" && Number.isFinite(listing.price) && listing.price > 0;
  });
  if (serious.length === 0) return { median: null, count: 0, excludedDump: false };

  const floor = Math.min(...serious.map((listing) => cents(listing.price ?? 0)));
  const atFloor = serious.filter((listing) => cents(listing.price ?? 0) === floor);
  let pool = serious;
  let excludedDump = false;
  const lone = atFloor[0];
  if (atFloor.length === 1 && lone && is107RowP(lone)) {
    pool = serious.filter((listing) => listing !== lone);
    excludedDump = true;
  }

  const prices = pool
    .map((listing) => listing.price)
    .filter((price): price is number => typeof price === "number");
  const middle = medianOf(prices);
  return {
    median: middle == null ? null : roundMoney(middle),
    count: prices.length,
    excludedDump,
  };
}

function moneyField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function gameRecord(game: Game): Record<string, unknown> {
  return game as Game & Record<string, unknown>;
}

function detailRecord(game: Game): Record<string, unknown> | null {
  const snapshot = game.market_details;
  if (!snapshot || typeof snapshot !== "object") return null;
  return snapshot as Record<string, unknown>;
}

export function compMedianOf(game: Game): number | null {
  const details = detailRecord(game);
  return (
    moneyField(game.comp_median) ??
    moneyField(gameRecord(game).compMedian) ??
    moneyField(details?.comp_median) ??
    moneyField(details?.compMedian) ??
    moneyField(details?.zone_median)
  );
}

export function compCountOf(game: Game): number | null {
  const details = detailRecord(game);
  const raw =
    game.comp_count ??
    gameRecord(game).compCount ??
    details?.comp_count ??
    details?.compCount ??
    details?.zone_comp_count;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

export function compPullsOf(game: Game): number {
  const details = detailRecord(game);
  const raw = game.comp_pulls ?? gameRecord(game).compPulls ?? details?.comp_pulls ?? details?.compPulls;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.round(raw);
}

export function compConfidenceOf(game: Game): CompConfidence | null {
  const details = detailRecord(game);
  const raw =
    game.comp_confidence ??
    gameRecord(game).compConfidence ??
    details?.comp_confidence ??
    details?.compConfidence;
  if (raw === "thin" || raw === "building" || raw === "solid") return raw;
  return null;
}

export function heldPriorOf(game: Game): boolean {
  const details = detailRecord(game);
  const raw =
    game.comp_held_prior ??
    gameRecord(game).compHeldPrior ??
    details?.comp_held_prior ??
    details?.compHeldPrior;
  return raw === true;
}

export function snapshotMedianOf(game: Game): number | null {
  const details = detailRecord(game);
  return (
    moneyField(game.comp_snapshot_median) ??
    moneyField(gameRecord(game).compSnapshotMedian) ??
    moneyField(details?.comp_snapshot_median) ??
    moneyField(details?.compSnapshotMedian)
  );
}

export function excludedDumpOf(game: Game): boolean {
  const details = detailRecord(game);
  const raw =
    game.comp_excluded_dump ??
    gameRecord(game).compExcludedDump ??
    details?.comp_excluded_dump ??
    details?.compExcludedDump;
  return raw === true;
}

function normalizeDemand(value: unknown): Demand | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "bigger" || key === "premium" || key === "big") return "bigger";
  if (key === "soft" || key === "softer") return "soft";
  if (key === "standard" || key === "normal") return "standard";
  return null;
}

/** Explicit mark only. Notes and opponent names are not a tier. */
export function demandOf(game: Game): Demand | null {
  const details = detailRecord(game);
  return (
    normalizeDemand(game.demand) ??
    normalizeDemand(gameRecord(game).tier) ??
    normalizeDemand(details?.demand) ??
    normalizeDemand(details?.tier)
  );
}

function modelLabel(chance: number | null): string {
  if (chance == null) return "Model ask.";
  return `Model ask: about ${Math.round(chance * 100)}% chance the pair sells before tip.`;
}

export function resolveSeatPrice(args: {
  modelAsk: ModelAsk | null;
  listedMedian: number | null;
  compCount: number | null;
  excludedDump: boolean;
  daysOut: number | null;
  savedTypeIn: number | null;
  pulls?: number | null;
  confidence?: CompConfidence | null;
  heldPrior?: boolean;
  snapshotMedian?: number | null;
}): SeatPriceView {
  const ask = args.modelAsk?.ask;
  const heldPrior = args.heldPrior === true;
  const suggestion: Suggestion | null =
    ask != null && Number.isFinite(ask) && ask > 0
      ? {
          typeIn: Math.max(1, roundDollar(ask)),
          keep: keepFromTypeIn(Math.max(1, roundDollar(ask))),
          pair: pairFromTypeIn(Math.max(1, roundDollar(ask))),
          listedMedian: args.listedMedian != null && args.listedMedian > 0 ? args.listedMedian : null,
          compCount: args.compCount,
          excludedDump: args.excludedDump,
          saleChance: args.modelAsk?.chance ?? null,
          label: modelLabel(args.modelAsk?.chance ?? null),
          daysOut: args.daysOut,
          heldPrior,
          historyNote:
            args.listedMedian != null && args.listedMedian > 0
              ? compHistoryNote({
                  pulls: args.pulls ?? 0,
                  confidence: args.confidence ?? null,
                  heldPrior,
                  snapshotMedian: args.snapshotMedian ?? null,
                  blendedMedian: args.listedMedian,
                })
              : null,
        }
      : null;
  const saved =
    args.savedTypeIn != null && Number.isFinite(args.savedTypeIn) && args.savedTypeIn > 0
      ? Math.max(1, roundDollar(args.savedTypeIn))
      : null;
  const typeIn = saved ?? suggestion?.typeIn ?? null;
  const hasSaved = saved != null;
  return {
    typeIn,
    keep: typeIn == null ? null : keepFromTypeIn(typeIn),
    pair: typeIn == null ? null : pairFromTypeIn(typeIn),
    savedTypeIn: saved,
    hasSaved,
    usingOwn: hasSaved && (suggestion == null || saved !== suggestion.typeIn),
    suggestion,
    emptyNote: suggestion
      ? null
      : args.excludedDump
        ? "Only a cheap 107P listing is up, so there is no middle yet."
        : args.listedMedian == null
          ? "No similar seats listed yet (107, 108, 118, 119, rows J–T)."
          : "The price model has no ask for this game yet.",
  };
}

/** The model ask the book carries for this game, if any. */
export function modelAskOf(game: Game): ModelAsk | null {
  const ask = game.model_ask;
  if (typeof ask !== "number" || !Number.isFinite(ask) || ask <= 0) return null;
  return { ask, chance: game.model_sale_chance ?? null, expected: game.model_expected ?? null };
}

export function seatPriceForGame(
  game: Game,
  savedTypeIn: number | null,
  todayEt: string,
): SeatPriceView {
  return resolveSeatPrice({
    modelAsk: modelAskOf(game),
    listedMedian: compMedianOf(game),
    compCount: compCountOf(game),
    excludedDump: excludedDumpOf(game),
    daysOut: daysUntil(game.date, todayEt),
    savedTypeIn,
    pulls: compPullsOf(game),
    confidence: compConfidenceOf(game),
    heldPrior: heldPriorOf(game),
    snapshotMedian: snapshotMedianOf(game),
  });
}
