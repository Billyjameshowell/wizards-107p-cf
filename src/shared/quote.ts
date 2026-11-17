/**
 * Suggested ask for Section 107 Row P, per seat, seller dollars.
 *
 * The number to type in follows today's comparable pairs. It does not scale a
 * get-in by a fixed multiplier, and it does not sit a fixed percent above a
 * four-section median.
 *
 * Comps are rows J–T, quantity of at least 2. Section 107 is the anchor.
 * Sections 108, 118 and 119 are used only when 107 is empty or has a single
 * pair. SeatData `listing.price` has no all-in flag and is stored as the
 * seller's list price (the same dollars as "Set Your Price"). Buyer all-in
 * on Ticketmaster is about 1.23× that. Billy's $75 floor is not an input.
 *
 * Fallback priors (used when the archive cannot move a factor, and for a game
 * with no comps). A standard Friday 7:00 PM regular-season game, two weeks or
 * more out, is $72. Other games scale that:
 *
 *   opponent     marquee 1.32, standard 1, soft 0.84; preseason 0.48 instead of tier
 *   day          Sun 1.05, Mon 0.90, Tue 0.95, Wed 0.98, Thu 0.92, Fri 1, Sat 1.08
 *                Weekend is those Sat/Sun factors, not a second multiplier.
 *   tip          before 5:00 PM 0.96, 5:00–8:00 PM 1, after 8:00 PM 1.03
 *   national TV  1.04
 *   days to tip  marquee holds (game day 0.96 of the two-week price),
 *                standard sags (0.78), soft and preseason sag harder (0.66)
 *
 * The archive fit (fitQuoteFactors) replaces a prior only when that slice has
 * enough checks, and it shrinks toward the prior. Supply rules are not fit:
 * the saved middle mixes sections, so it cannot say whether 107 was crowded.
 *
 *   8+ pairs in 107     30th percentile (cheaper rows)
 *   4–7                 40th percentile
 *   2–3                 50th percentile
 *   1 pair, neighbors   60th percentile of the neighbors, then +12%
 *   1 pair, alone       the higher of that pair +15% and 90% of the prior
 *   no 107, neighbors   50th percentile of the neighbors, then +18%
 *   no comps            the prior
 *
 * Same-day comps are not decayed again (the board has already moved). An older
 * board is walked from the day it was pulled to today along the decay curve.
 */

import {
  COMP_ROWS,
  extractSectionNumber,
  normalizeRow,
  pairFromTypeIn,
  roundMoney,
} from "./book";
import {
  isNationalTv,
  isWeekendGame,
  opponentTier,
  saleProbability,
  type MarketRow,
  type OpponentTier,
} from "./price-model";
import { BUYER_ALL_IN_MULTIPLE } from "./pricing";

export const QUOTE_VERSION = "2";
export const BASE_SELLER = 72;

export const TIER_PRIOR = { marquee: 1.32, standard: 1, soft: 0.84 } as const;
export const PRESEASON_PRIOR = 0.48;
export const DOW_PRIOR = { Sun: 1.05, Mon: 0.9, Tue: 0.95, Wed: 0.98, Thu: 0.92, Fri: 1, Sat: 1.08 } as const;
export const TIP_PRIOR = { early: 0.96, prime: 1, late: 1.03 } as const;
export const NATIONAL_TV_PRIOR = 1.04;
/** Values at 14, 7, 3, 1 and 0 days out. Day 14 is 1. */
export const DECAY_PRIOR = {
  hold: [1, 0.99, 0.98, 0.97, 0.96],
  mid: [1, 0.96, 0.9, 0.84, 0.78],
  sag: [1, 0.92, 0.82, 0.74, 0.66],
} as const;

const DECAY_DAYS = [14, 7, 3, 1, 0] as const;
const NEIGHBORS = new Set(["108", "118", "119"]);

export type DecayKind = keyof typeof DECAY_PRIOR;
export type TipBucket = keyof typeof TIP_PRIOR;
export type DowName = keyof typeof DOW_PRIOR;

export type QuoteFactors = {
  version: string;
  source: "prior" | "archive";
  /** 0 is the written prior. 1 means the archive was thick enough to stand on. */
  weight: number;
  rows: number;
  games: number;
  observedGames: number;
  base: number;
  tier: Record<OpponentTier, number>;
  preseason: number;
  dow: Record<DowName, number>;
  tip: Record<TipBucket, number>;
  nationalTv: number;
  decay: Record<DecayKind, number[]>;
};

export type QuoteListing = {
  section?: string | null;
  row?: string | null;
  quantity?: number | null;
  price?: number | null;
  active?: boolean | number | null;
};

export type QuoteInput = {
  listings: readonly QuoteListing[];
  daysOut: number;
  /** Days before tip when `listings` were pulled. Defaults to `daysOut`. */
  compDaysOut?: number;
  opponent: string;
  demand?: string | null;
  weekday: string;
  date: string;
  timeEt?: string | null;
  type?: string | null;
  notes?: string | null;
  nationalTv?: boolean;
  listedAsk?: number | null;
  /**
   * Middle saved on a pull that did not keep listing rows. Used only when
   * `listings` has no comp-zone pairs. Not a get-in.
   */
  summaryMedian?: number | null;
  summaryCount?: number | null;
  factors?: QuoteFactors;
};

export type MarketQuote = {
  seller: number;
  allIn: number;
  low: number;
  high: number;
  saleChance: number;
  expected: number;
  /** Seller dollars the same path puts on the price at tip. */
  tip: number;
  sectionCount: number;
  neighborCount: number;
  cheapest107: number | null;
  /** Our list, or the ask when nothing is listed, minus the cheapest 107 pair. */
  delta: number | null;
  deltaOn: "list" | "ask" | null;
  pool: "107" | "neighbors" | "summary" | "prior";
  sentence: string;
  usedComps: boolean;
};

type LevelContext = {
  tier: OpponentTier;
  weekend: boolean;
  daysOut: number;
  weekday?: string;
  tip?: TipBucket;
  preseason?: boolean;
  nationalTv?: boolean;
};

export function tipBucket(timeEt: string | null | undefined): TipBucket {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(timeEt ?? "");
  if (!match) return "prime";
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const ap = match[3]!.toLowerCase();
  if (ap.startsWith("p") && hour !== 12) hour += 12;
  if (ap.startsWith("a") && hour === 12) hour = 0;
  const mins = hour * 60 + minute;
  if (mins < 17 * 60) return "early";
  if (mins >= 20 * 60) return "late";
  return "prime";
}

export function dowName(weekday: string, date: string): DowName {
  const name = weekday.trim().slice(0, 3).toLowerCase();
  const named: Record<string, DowName> = {
    sun: "Sun",
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
  };
  if (named[name]) return named[name];
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const)[day] ?? "Fri";
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const left = sorted[low] ?? 0;
  const right = sorted[high] ?? left;
  if (low === high) return left;
  return left * (high - index) + right * (index - low);
}

export function decayAt(curve: readonly number[], daysOut: number): number {
  const days = Math.max(0, daysOut);
  if (days >= 14) return curve[0] ?? 1;
  for (let index = 0; index < DECAY_DAYS.length - 1; index += 1) {
    const leftDay = DECAY_DAYS[index] ?? 14;
    const rightDay = DECAY_DAYS[index + 1] ?? 0;
    if (days <= leftDay && days >= rightDay && leftDay !== rightDay) {
      const t = (leftDay - days) / (leftDay - rightDay);
      const left = curve[index] ?? 1;
      const right = curve[index + 1] ?? left;
      return left * (1 - t) + right * t;
    }
  }
  return curve[curve.length - 1] ?? 1;
}

export function buyerAllIn(seller: number): number {
  return roundMoney(seller * BUYER_ALL_IN_MULTIPLE);
}

/** Seller list from a prior or a fitted factor set. No comps. */
export function levelAsk(factors: QuoteFactors, row: LevelContext): number {
  const tier = row.preseason ? factors.preseason : factors.tier[row.tier];
  const dow = factors.dow[row.weekday ? dowName(row.weekday, "2000-01-01") : row.weekend ? "Sun" : "Fri"];
  const tip = factors.tip[row.tip ?? "prime"];
  const kind = decayKind(row.tier, row.preseason === true);
  const decay = decayAt(factors.decay[kind], row.daysOut);
  const tv = row.nationalTv ? factors.nationalTv : 1;
  return factors.base * tier * dow * tip * decay * tv;
}

export function quoteGame(input: QuoteInput): MarketQuote {
  const factors = input.factors ?? priorFactors(0, 0, 0);
  const daysOut = Math.max(0, input.daysOut);
  const compDaysOut = input.compDaysOut ?? daysOut;
  const context = levelContext(input, daysOut);
  const prior = levelAsk(factors, context);
  const section = pricesIn(input.listings, "107");
  const neighbors = pricesIn(input.listings, "neighbors");
  const cheapest = section.length > 0 ? (section[0] ?? null) : null;
  const anchored = anchor(section, neighbors, prior, input.summaryMedian, input.summaryCount);
  const kind = decayKind(context.tier, context.preseason === true);
  const shade =
    anchored.pool === "prior"
      ? 1
      : decayAt(factors.decay[kind], daysOut) / Math.max(0.5, decayAt(factors.decay[kind], compDaysOut));
  const seller = Math.max(1, Math.round(anchored.price * shade));
  const low = Math.max(1, Math.min(seller, Math.round(anchored.low * shade)));
  const high = Math.max(seller, Math.round(anchored.high * shade));
  const toTip = decayAt(factors.decay[kind], 0) / Math.max(0.5, decayAt(factors.decay[kind], daysOut));
  const tip = Math.max(1, Math.round(seller * toTip));
  const mid = (anchored.mid > 0 ? anchored.mid : seller) * shade;
  const saleChance = round3(
    saleProbability({
      ask: seller,
      predictedMedian: mid > 0 ? mid : seller,
      daysOut,
    }),
  );
  const expected = roundMoney(saleChance * pairFromTypeIn(seller));
  const ours = input.listedAsk != null && input.listedAsk > 0 ? input.listedAsk : seller;
  const deltaOn = cheapest == null ? null : input.listedAsk != null && input.listedAsk > 0 ? "list" : "ask";
  const delta = cheapest == null ? null : Math.round(ours - cheapest);
  return {
    seller,
    allIn: buyerAllIn(seller),
    low,
    high,
    saleChance,
    expected,
    tip,
    sectionCount: section.length,
    neighborCount: neighbors.length,
    cheapest107: cheapest == null ? null : roundMoney(cheapest),
    delta,
    deltaOn,
    pool: anchored.pool,
    usedComps: anchored.pool !== "prior",
    sentence: quoteSentence({
      seller,
      allIn: buyerAllIn(seller),
      low,
      high,
      sectionCount: section.length,
      neighborCount: neighbors.length,
      pool: anchored.pool,
      early: factors.source === "prior" && anchored.pool === "prior",
    }),
  };
}

export function priorFactors(rows = 0, games = 0, observedGames = 0): QuoteFactors {
  return {
    version: QUOTE_VERSION,
    source: "prior",
    weight: 0,
    rows,
    games,
    observedGames,
    base: BASE_SELLER,
    tier: { ...TIER_PRIOR },
    preseason: PRESEASON_PRIOR,
    dow: { ...DOW_PRIOR },
    tip: { ...TIP_PRIOR },
    nationalTv: NATIONAL_TV_PRIOR,
    decay: {
      hold: [...DECAY_PRIOR.hold],
      mid: [...DECAY_PRIOR.mid],
      sag: [...DECAY_PRIOR.sag],
    },
  };
}

/**
 * Move the priors toward the archive. Thin slices stay on the prior.
 * Supply percentiles stay on the rules above.
 */
export function fitQuoteFactors(rows: readonly MarketRow[], today = "9999-12-31"): QuoteFactors {
  const clean = rows.filter(usableRow);
  const games = new Set(clean.map((row) => row.gameDate));
  const observed = new Set(clean.filter((row) => row.gameDate <= today).map((row) => row.gameDate));
  const factors = priorFactors(clean.length, games.size, observed.size);
  if (clean.length < 24 || games.size < 4) return factors;

  factors.source = "archive";
  factors.weight = Math.min(1, Math.round((clean.length / 80) * 100) / 100);
  const window = clean.filter((row) => row.daysOut >= 7 && row.daysOut <= 21 && !row.preseason);

  const baseRows = clean.filter((row) => row.tier === "standard" && !row.weekend && row.daysOut >= 14 && !row.preseason);
  if (baseRows.length >= 8) factors.base = shrink(median(baseRows.map((row) => row.median)), BASE_SELLER, baseRows.length, 24);

  const standardLevel = median(window.filter((row) => row.tier === "standard").map((row) => row.median));
  if (standardLevel > 0) {
    for (const tier of ["marquee", "soft"] as const) {
      const slice = window.filter((row) => row.tier === tier);
      if (slice.length < 4) continue;
      factors.tier[tier] = shrink(median(slice.map((row) => row.median)) / standardLevel, TIER_PRIOR[tier], slice.length, 12);
    }
  }

  const pre = clean.filter((row) => row.preseason && row.daysOut >= 7);
  const regular = clean.filter((row) => !row.preseason && row.tier === "standard" && row.daysOut >= 7 && row.daysOut <= 21);
  if (pre.length >= 4 && regular.length >= 4) {
    const regularLevel = median(regular.map((row) => row.median));
    if (regularLevel > 0) {
      factors.preseason = shrink(median(pre.map((row) => row.median)) / regularLevel, PRESEASON_PRIOR, pre.length, 8);
    }
  }

  if (window.some((row) => row.weekday)) {
    for (const name of Object.keys(DOW_PRIOR) as DowName[]) {
      const slice = window.filter((row) => row.weekday && dowName(row.weekday, row.gameDate) === name);
      if (slice.length < 4 || factors.base <= 0) continue;
      const ratios = slice.map((row) => row.median / (factors.base * (row.preseason ? factors.preseason : factors.tier[row.tier])));
      factors.dow[name] = shrink(median(ratios), DOW_PRIOR[name], slice.length, 8);
    }
  }

  if (window.some((row) => row.tip)) {
    for (const name of Object.keys(TIP_PRIOR) as TipBucket[]) {
      const slice = window.filter((row) => row.tip === name);
      if (slice.length < 4) continue;
      const ratios = slice.map((row) => {
        const dow = factors.dow[row.weekday ? dowName(row.weekday, row.gameDate) : row.weekend ? "Sun" : "Fri"];
        const tier = row.preseason ? factors.preseason : factors.tier[row.tier];
        return row.median / (factors.base * tier * dow);
      });
      factors.tip[name] = shrink(median(ratios), TIP_PRIOR[name], slice.length, 8);
    }
  }

  const tv = window.filter((row) => row.nationalTv);
  const noTv = window.filter((row) => !row.nationalTv && row.tier === "standard");
  if (tv.length >= 4 && noTv.length >= 4) {
    const plain = median(noTv.map((row) => row.median));
    if (plain > 0) factors.nationalTv = shrink(median(tv.map((row) => row.median)) / plain, NATIONAL_TV_PRIOR, tv.length, 8);
  }

  for (const kind of ["hold", "mid", "sag"] as const) {
    const ratios: number[] = [];
    for (const list of groupBy(clean, (row) => row.gameDate).values()) {
      const sample = list[0];
      if (!sample || decayKind(sample.tier, sample.preseason === true) !== kind) continue;
      const far = list.filter((row) => row.daysOut >= 10).map((row) => row.median);
      const near = list.filter((row) => row.daysOut <= 2).map((row) => row.median);
      if (far.length === 0 || near.length === 0) continue;
      const farMid = median(far);
      if (farMid > 0) ratios.push(median(near) / farMid);
    }
    if (ratios.length >= 4) {
      const day0 = shrink(median(ratios), DECAY_PRIOR[kind][4] ?? 1, ratios.length, 8);
      factors.decay[kind] = scaleDecay(factors.decay[kind], day0);
    }
  }

  return factors;
}

/** Typical percent miss of the factor level on each game's latest check, left out of the fit. */
export function quoteHoldoutPercent(rows: readonly MarketRow[], today = "9999-12-31"): number | null {
  const byGame = groupBy(rows.filter(usableRow), (row) => row.gameDate);
  const train: MarketRow[] = [];
  const held: MarketRow[] = [];
  for (const list of byGame.values()) {
    const sorted = list.slice().sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
    if (sorted.length < 2) {
      train.push(...sorted);
      continue;
    }
    held.push(sorted[sorted.length - 1] as MarketRow);
    train.push(...sorted.slice(0, -1));
  }
  if (held.length < 5) return null;
  const factors = fitQuoteFactors(train, today);
  const errors: number[] = [];
  for (const row of held) {
    const predicted = levelAsk(factors, row);
    if (predicted > 0 && row.median > 0) errors.push(Math.abs(predicted - row.median) / row.median);
  }
  if (errors.length < 5) return null;
  return Math.round(median(errors) * 1000) / 10;
}

export function isQuoteListing(listing: QuoteListing): boolean {
  const active = listing.active == null || listing.active === true || listing.active === 1;
  if (!active) return false;
  if ((listing.quantity ?? 0) < 2) return false;
  if (typeof listing.price !== "number" || !(listing.price > 0)) return false;
  const section = extractSectionNumber(listing.section ?? undefined);
  const row = normalizeRow(listing.row ?? undefined);
  if (!section || !row) return false;
  if (!(COMP_ROWS as readonly string[]).includes(row)) return false;
  return section === "107" || NEIGHBORS.has(section);
}

function levelContext(input: QuoteInput, daysOut: number): LevelContext {
  return {
    tier: opponentTier(input.opponent, input.demand),
    weekend: isWeekendGame(input.weekday, input.date),
    daysOut,
    weekday: input.weekday,
    tip: tipBucket(input.timeEt),
    preseason: (input.type ?? "").toLowerCase() === "preseason",
    nationalTv: isNationalTv(input.notes, input.nationalTv),
  };
}

function decayKind(tier: OpponentTier, preseason: boolean): DecayKind {
  if (preseason || tier === "soft") return "sag";
  if (tier === "marquee") return "hold";
  return "mid";
}

function pricesIn(listings: readonly QuoteListing[], which: "107" | "neighbors"): number[] {
  const prices: number[] = [];
  for (const listing of listings) {
    if (!isQuoteListing(listing)) continue;
    const section = extractSectionNumber(listing.section ?? undefined);
    const inSection = section === "107";
    if (which === "107" ? !inSection : !section || !NEIGHBORS.has(section)) continue;
    prices.push(listing.price as number);
  }
  prices.sort((a, b) => a - b);
  return prices;
}

function anchor(
  section: readonly number[],
  neighbors: readonly number[],
  prior: number,
  summaryMedian?: number | null,
  summaryCount?: number | null,
): { price: number; low: number; high: number; mid: number; pool: MarketQuote["pool"] } {
  if (section.length >= 2) {
    const p = section.length >= 8 ? 0.3 : section.length >= 4 ? 0.4 : 0.5;
    return band(section, p, "107");
  }
  if (section.length === 1 && neighbors.length > 0) {
    return scaleBand(band(neighbors, 0.6, "neighbors"), 1.12);
  }
  if (section.length === 1) {
    const lifted = (section[0] ?? prior) * 1.15;
    const price = Math.max(lifted, prior * 0.9);
    return { price, low: Math.min(section[0] ?? price, price), high: Math.max(price, prior), mid: price, pool: "107" };
  }
  if (neighbors.length > 0) return scaleBand(band(neighbors, 0.5, "neighbors"), 1.18);
  if (summaryMedian != null && summaryMedian > 0) {
    // No rows, so the cheap-side shift is a stand-in for the percentile a full board would use.
    const count = summaryCount ?? 0;
    const shift = count >= 8 ? 0.85 : count >= 4 ? 0.92 : count === 1 ? 1.15 : 1;
    const price = summaryMedian * shift;
    return { price, low: summaryMedian * 0.75, high: Math.max(price, summaryMedian), mid: summaryMedian, pool: "summary" };
  }
  return { price: prior, low: prior * 0.85, high: prior * 1.15, mid: prior, pool: "prior" };
}

function band(
  sorted: readonly number[],
  p: number,
  pool: "107" | "neighbors",
): { price: number; low: number; high: number; mid: number; pool: "107" | "neighbors" } {
  const price = percentile(sorted, p) ?? sorted[0] ?? 0;
  const low = percentile(sorted, 0.15) ?? price;
  const high = percentile(sorted, 0.75) ?? price;
  const mid = percentile(sorted, 0.5) ?? price;
  return { price, low, high, mid, pool };
}

function scaleBand(
  value: { price: number; low: number; high: number; mid: number; pool: "107" | "neighbors" },
  premium: number,
): { price: number; low: number; high: number; mid: number; pool: "107" | "neighbors" } {
  return {
    price: value.price * premium,
    low: value.low * premium,
    high: value.high * premium,
    mid: value.mid * premium,
    pool: value.pool,
  };
}

function quoteSentence(quote: {
  seller: number;
  allIn: number;
  low: number;
  high: number;
  sectionCount: number;
  neighborCount: number;
  pool: MarketQuote["pool"];
  early: boolean;
}): string {
  const ask = `Ask ${dollars(quote.seller)} a seat. Buyers pay about ${dollars(quote.allIn)}.`;
  const range = `The range is ${dollars(quote.low)}–${dollars(quote.high)}.`;
  if (quote.pool === "107" && quote.sectionCount >= 8) {
    return `${ask} ${quote.sectionCount} pairs in section 107, so this follows the cheaper rows. ${range}`;
  }
  if (quote.pool === "107" && quote.sectionCount >= 2) {
    return `${ask} ${quote.sectionCount} pairs in section 107. ${range}`;
  }
  if (quote.pool === "neighbors") {
    const own = quote.sectionCount === 1 ? "Section 107 has one pair, so this is priced up from" : "Section 107 has no other pair, so this is priced up from";
    return `${ask} ${own} ${quote.neighborCount} ${quote.neighborCount === 1 ? "pair" : "pairs"} next door. ${range}`;
  }
  if (quote.pool === "107") {
    return `${ask} Section 107 has one pair and nothing next door, so this is priced up from that pair and from similar games. ${range}`;
  }
  if (quote.pool === "summary") {
    return `${ask} This follows the saved middle of similar seats. Row-by-row prices were not kept, so the cheap-side shift is approximate. ${range}`;
  }
  const early = quote.early ? " Day, tip time and opponent are an early estimate until more checks are in." : "";
  return `${ask} No similar pairs are listed yet, so this uses the day, the tip time and the opponent.${early} ${range}`;
}

function usableRow(row: MarketRow): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(row.gameDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.snapshotDate) &&
    Number.isFinite(row.daysOut) &&
    row.daysOut >= 0 &&
    Number.isFinite(row.median) &&
    row.median > 0
  );
}

function shrink(fitted: number, prior: number, n: number, need: number): number {
  if (!(fitted > 0) || !(prior > 0)) return prior;
  const weight = Math.max(0, Math.min(1, n / need));
  return Math.exp(Math.log(prior) * (1 - weight) + Math.log(fitted) * weight);
}

function scaleDecay(curve: readonly number[], gameDay: number): number[] {
  const current = curve[curve.length - 1] ?? 1;
  if (!(current > 0) || !(gameDay > 0)) return [...curve];
  const ratio = gameDay / current;
  return curve.map((value, index) => value * Math.pow(ratio, index / Math.max(1, curve.length - 1)));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return percentile(sorted, 0.5) ?? 0;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  return groups;
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
