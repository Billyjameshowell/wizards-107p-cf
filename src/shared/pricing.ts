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
 * count more. A thin morning stays near those recent prices. A busy morning
 * follows the live middle. The day rules below still apply to that blended
 * middle. A number he typed is still never replaced.
 *
 * Suggestion vs that listed middle (the type-in, before the 5% fee):
 * - Default is the middle itself. Do not start under it.
 * - Above it only when the game is marked bigger AND tip is still more than
 *   three weeks out (22+ days). The step is 10%, the modest end of the
 *   10–20% broker range.
 * - Under it only when the game is marked softer AND tip is today through
 *   14 days out (inside about two weeks, which includes a few days). The
 *   step is 5%.
 * - Standard games, and any game that is not marked, stay on the middle.
 *   That includes the active window from about three weeks out (21 days)
 *   through about one week out (7 days).
 * - A past game stays on the middle.
 * - What he paid for the season does not move the suggestion. $6,000 is only
 *   the running cash goal.
 * - There is no view count on the book, so quiet interest does not cut the
 *   price. He can type his own number when he needs the seats to move.
 *
 * Rounding the suggestion (not a number he typed himself):
 * the number to type is the nearest whole dollar ending in 0 or 5
 * ($150, $175, $200). Halves round up ($177.50 → $180). No cents and no
 * .99 prices. A dollar ending in 9 ($199, not $149 in place of $150) is
 * used only when that 9 has a smaller first digit than the unrounded
 * middle, and the 0-ending price does not already sit on a smaller first
 * digit. So a middle of $200 becomes type $199, and a middle of $150 stays
 * $150. You-keep is then exactly 95% of that dollar, to the cent.
 * If this rounding would erase a required step above or below the middle,
 * move one more $5 so the step still shows.
 *
 * A saved type-in is any whole dollar he chose. It is never passed through
 * this rounding, and it is never replaced when days or comps change.
 */

/** More than three weeks out. */
export const FAR_OUT_MIN_DAYS = 22;
/** Inside about two weeks, including a few days and tip day. */
export const SOFT_WINDOW_MAX_DAYS = 14;
/** Modest end of the 10–20% “bigger game, still far out” step. */
export const BIGGER_PREMIUM_RATE = 0.1;
/** Small step under the middle. Not a dump. */
export const SOFT_STEP_RATE = 0.05;

export type Demand = "bigger" | "soft" | "standard";
export type Stance = "above" | "below" | "at";

export type CompMedian = {
  median: number | null;
  count: number;
  excludedDump: boolean;
};

export type Suggestion = {
  typeIn: number;
  keep: number;
  pair: number;
  listedMedian: number;
  compCount: number | null;
  excludedDump: boolean;
  stance: Stance;
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

function leadingDigit(value: number): { digit: number; places: number } {
  const whole = Math.max(0, Math.floor(Math.abs(value)));
  const text = String(whole);
  return { digit: Number(text[0] ?? "0"), places: text.length };
}

/** True when `nine` shows a smaller first digit than the unrounded middle. */
function dropsFirstDigit(nine: number, unroundedMedian: number): boolean {
  const low = leadingDigit(nine);
  const middle = leadingDigit(unroundedMedian);
  if (low.places < middle.places) return true;
  if (low.places > middle.places) return false;
  return low.digit < middle.digit;
}

function firstDigitAtLeast(price: number, unroundedMedian: number): boolean {
  const typed = leadingDigit(price);
  const middle = leadingDigit(unroundedMedian);
  if (typed.places > middle.places) return true;
  if (typed.places < middle.places) return false;
  return typed.digit >= middle.digit;
}

/**
 * Suggested “Set Your Price” dollar. Ends in 0 or 5, except a 9 when that
 * 9 drops the first digit versus the unrounded middle ($199 instead of $200).
 * `raw` is the middle after any bigger/softer step. The first-digit check
 * always uses the unrounded middle, not the stepped figure.
 */
export function roundSuggestedTypeIn(raw: number, unroundedMedian: number): number {
  const five = Math.round(raw / 5) * 5;
  if (five >= 1 && five % 10 === 0) {
    const nine = five - 1;
    if (
      nine >= 1 &&
      dropsFirstDigit(nine, unroundedMedian) &&
      firstDigitAtLeast(five, unroundedMedian)
    ) {
      return nine;
    }
  }
  return Math.max(1, five);
}

function nextEnding(price: number, direction: 1 | -1): number {
  if (direction > 0) {
    const up = Math.floor(price / 5) * 5 + 5;
    return up > price ? up : price + 5;
  }
  const down = Math.ceil(price / 5) * 5 - 5;
  return down < price ? down : price - 5;
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

function stanceLabel(stance: Stance, demand: Demand | null, daysOut: number | null): string {
  if (stance === "above") {
    return "About 10% above the middle. Bigger game, more than three weeks out.";
  }
  if (stance === "below") {
    return "About 5% under the middle. Softer game, inside two weeks of tip.";
  }
  if (daysOut != null && daysOut < 0) {
    return "On the middle of those listings. This game has already tipped.";
  }
  if (demand === "bigger") {
    if (daysOut == null) {
      return "On the middle of those listings. Bigger game, and the days until tip are not set.";
    }
    return "On the middle of those listings. Bigger game, and tip is inside three weeks.";
  }
  if (demand === "soft") {
    if (daysOut == null) {
      return "On the middle of those listings. Softer game, and the days until tip are not set.";
    }
    return "On the middle of those listings. Softer game, and tip is still more than two weeks away.";
  }
  if (demand == null) {
    return "On the middle of those listings. This game has no bigger or softer mark.";
  }
  return "On the middle of those listings.";
}

export function suggestFromMedian(args: {
  listedMedian: number;
  daysOut: number | null;
  demand: Demand | null;
  compCount?: number | null;
  excludedDump?: boolean;
}): Suggestion {
  const daysOut = args.daysOut;
  let stance: Stance = "at";
  let factor = 1;
  if (args.demand === "bigger" && daysOut != null && daysOut >= FAR_OUT_MIN_DAYS) {
    stance = "above";
    factor = 1 + BIGGER_PREMIUM_RATE;
  } else if (
    args.demand === "soft" &&
    daysOut != null &&
    daysOut >= 0 &&
    daysOut <= SOFT_WINDOW_MAX_DAYS
  ) {
    stance = "below";
    factor = 1 - SOFT_STEP_RATE;
  }

  const baseline = Math.max(1, roundSuggestedTypeIn(args.listedMedian, args.listedMedian));
  let typeIn = Math.max(1, roundSuggestedTypeIn(args.listedMedian * factor, args.listedMedian));
  if (stance === "above" && typeIn <= baseline) typeIn = nextEnding(baseline, 1);
  if (stance === "below" && typeIn >= baseline) {
    const stepped = nextEnding(baseline, -1);
    if (stepped < 1) {
      typeIn = baseline;
      stance = "at";
    } else {
      typeIn = stepped;
    }
  }

  return {
    typeIn,
    keep: keepFromTypeIn(typeIn),
    pair: pairFromTypeIn(typeIn),
    listedMedian: args.listedMedian,
    compCount: args.compCount ?? null,
    excludedDump: args.excludedDump === true,
    stance,
    label: stanceLabel(stance, args.demand, daysOut),
    daysOut,
    heldPrior: false,
    historyNote: null,
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

export function resolveSeatPrice(args: {
  listedMedian: number | null;
  compCount: number | null;
  excludedDump: boolean;
  daysOut: number | null;
  demand: Demand | null;
  savedTypeIn: number | null;
  pulls?: number | null;
  confidence?: CompConfidence | null;
  heldPrior?: boolean;
  snapshotMedian?: number | null;
}): SeatPriceView {
  const base =
    args.listedMedian != null && args.listedMedian > 0
      ? suggestFromMedian({
          listedMedian: args.listedMedian,
          daysOut: args.daysOut,
          demand: args.demand,
          compCount: args.compCount,
          excludedDump: args.excludedDump,
        })
      : null;
  const heldPrior = args.heldPrior === true;
  const suggestion = base
    ? {
        ...base,
        heldPrior,
        historyNote: compHistoryNote({
          pulls: args.pulls ?? 0,
          confidence: args.confidence ?? null,
          heldPrior,
          snapshotMedian: args.snapshotMedian ?? null,
          blendedMedian: base.listedMedian,
        }),
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
        ? "Only a cheap Section 107 Row P listing is up, so there is no middle to use yet."
        : "No listings yet in sections 107, 108, 118, and 119, rows J through T.",
  };
}

export function seatPriceForGame(
  game: Game,
  savedTypeIn: number | null,
  todayEt: string,
): SeatPriceView {
  return resolveSeatPrice({
    listedMedian: compMedianOf(game),
    compCount: compCountOf(game),
    excludedDump: excludedDumpOf(game),
    daysOut: daysUntil(game.date, todayEt),
    demand: demandOf(game),
    savedTypeIn,
    pulls: compPullsOf(game),
    confidence: compConfidenceOf(game),
    heldPrior: heldPriorOf(game),
    snapshotMedian: snapshotMedianOf(game),
  });
}
