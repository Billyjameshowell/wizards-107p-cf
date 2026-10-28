/**
 * Stage A fair price and Stage B list suggestion.
 *
 * Stage A fits log(comparable median) with plain least squares:
 * a shared natural cubic spline of days until tip, fixed effects, and a
 * per-game intercept shrunk toward the pack. Stage B picks asks that add
 * the most expected cash for the pair, then leans safer or more patient
 * so the season can clear its goal. Nothing here lists a ticket.
 *
 * Keep `fitMarketModel` and `projectGame` as the call shape.
 */

import { PAIR_SEATS, SEASON_COST_DEFAULT, SELLER_KEEP_RATE } from "./book";
import { formatChance } from "./format";

export const MODEL_VERSION = "1";
export const NOT_ENOUGH_DATA = "There isn't enough data yet.";
/** Cleaned game×day rows before the fit stands on its own. */
export const TRUST_ROWS = 800;
/** About half of a 43-game home slate. */
export const TRUST_OBSERVED_GAMES = 22;
/** Break-even net plus this share. 15% of $6,000 is a $6,900 season goal. */
export const SEASON_CUSHION_DEFAULT = 0.15;
/** A vanished pair this many days before tip can count as a possible sale. */
export const LIKELY_SOLD_MIN_DAYS = 3;
/** Within this many days of tip, a listing has to beat the instant offer. */
export const NEAR_TIP_DAYS = 7;
/** Same section, row, and quantity within this price band is a price edit. */
export const PRICE_EDIT_BAND = 0.08;
/** 80% of a normal curve sits inside ± this many standard deviations. */
export const BAND_Z = 1.2815515655446004;

const MIN_FIT_ROWS = 24;
const MIN_FIT_GAMES = 4;
const KNOTS = [7, 21, 45, 90] as const;
const LOG_CLAMP = 0.8;

/**
 * Chance an ask sells before tip: logistic in log(ask / middle) and log(1 + days
 * left), with days capped at SALE_DAYS_CAP because the archive only sees how
 * listings end within a few weeks of tip. calibrateSaleCurve fits the level and
 * the days term from how comparable pairs ended on games already played.
 *
 * The price slope is set, not fitted. Comparable pairs mix better and worse seats
 * (rows J-T in four sections), so pricier listings are often just better seats and
 * the archive's slope is blurred toward zero (about -1 near tip, flat further out).
 * A slope that flat makes the highest ask always look best. At -3 (the old hand
 * prior was -2.8) the most-expected-cash ask sits near the middle, about 5% over
 * it, with roughly a 65-70% sale chance two weeks or more out.
 *
 * The level and days term start at what the 2026-10-28 fit on played games gave
 * (about -1.57 and 0.89 on ~8,500 pair outcomes), so a refit that cannot run
 * still prices the same way.
 */
export const SALE_PRIORS = {
  intercept: -1.55,
  logRatio: -3,
  logDays: 0.9,
} as const;

export type SaleCurve = {
  intercept: number;
  logRatio: number;
  logDays: number;
};

/**
 * Days beyond this add no chance. Played games in the archive show how listings
 * end only within about two weeks of tip (SeatData listings start Oct 8), so the
 * curve is not stretched past what it has seen.
 */
export const SALE_DAYS_CAP = 14;
/** No ask is a sure sale; a pair can always go unsold. */
export const MAX_SALE_CHANCE = 0.95;

/** One comparable pair on a played game: listed at `ratio` of that day's middle, `daysOut` before tip. */
export type SaleOutcomeRow = {
  /** Its seats (section, row, quantity) were no longer listed at the last check before tip. */
  sold: boolean;
  ratio: number;
  daysOut: number;
};

/** One ask the cash plan can choose. `pair` is the cash if it sells. */
export type AskOffer = {
  ask: number;
  chance: number;
  pair: number;
  expected: number;
};

export type CashGame = {
  date: string;
  opponent: string;
  /** Sit. Left out of the cash plan. Sold games are not keeping. */
  keeping: boolean;
  sold: boolean;
  banked: number;
  offers: readonly AskOffer[];
};

export type SeasonLean = "safer" | "even" | "patient";

export type SeasonOutlook = {
  breakEven: number;
  cushion: number;
  target: number;
  banked: number;
  expectedRest: number;
  expectedTotal: number;
  chance: number;
  lean: SeasonLean;
  forSale: number;
  kept: number;
  /** For-sale games that have a price, so they are in the cash total. */
  priced: number;
  sentence: string;
  asks: Record<string, AskOffer>;
};

export type CompSnap = {
  gameDate: string;
  etDate: string;
  pulledAt: string;
  daysOut: number;
  section: string;
  row: string;
  quantity: number;
  price: number;
  supply: number | null;
  median: number | null;
};

export type ProbableSale = {
  gameDate: string;
  seenDate: string;
  goneDate: string;
  daysOut: number;
  section: string;
  row: string;
  quantity: number;
  price: number;
  certain: boolean;
  externalId: string;
  median: number | null;
  supply: number | null;
};

// 2026-27 draw tiers (reviewed Oct 27, 2026). A game's own `demand` field wins
// when set. Moves this season: Giannis went to Miami (Heat up, Bucks down), Durant
// is in Houston, Detroit won 60, Portland added Morant to Lillard, and Dallas no
// longer has Luka. Memphis, the Clippers and Sacramento start in the bottom three.
const MARQUEE = new Set([
  "boston celtics",
  "denver nuggets",
  "golden state warriors",
  "houston rockets",
  "los angeles lakers",
  "miami heat",
  "new york knicks",
  "oklahoma city thunder",
  "philadelphia 76ers",
  "san antonio spurs",
]);

const SOFT = new Set([
  "brooklyn nets",
  "charlotte hornets",
  "la clippers",
  "memphis grizzlies",
  "sacramento kings",
  "utah jazz",
]);

const TERM_NAMES = [
  "intercept",
  "days",
  "curve1",
  "curve2",
  "marquee",
  "soft",
  "weekend",
  "nationalTv",
  "winRate",
  "logSupply",
  "logInstant",
] as const;

export type TermName = (typeof TERM_NAMES)[number];
export type OpponentTier = "marquee" | "standard" | "soft";

export type MarketRow = {
  gameDate: string;
  snapshotDate: string;
  daysOut: number;
  median: number;
  tier: OpponentTier;
  weekend: boolean;
  nationalTv: boolean;
  /** Wizards wins / (wins + losses) that day. Null when unknown. */
  winRate: number | null;
  /** Comparable seats listed that day. Null when unknown. */
  supply: number | null;
  /** Guaranteed per-seat payout known on this day. Null when none was logged. */
  instantPerTicket?: number | null;
};

export type GameQuery = {
  gameDate: string;
  daysOut: number;
  tier: OpponentTier;
  weekend: boolean;
  nationalTv: boolean;
  winRate: number | null;
  supply: number | null;
  /** Latest middle of similar seats. Today's price is anchored here when there is one. */
  liveMedian: number | null;
  /** Guaranteed per-seat payout, when one is logged. */
  instantPerTicket?: number | null;
};

export type ListSuggestion = {
  ask: number | null;
  hold: boolean;
  saleChance: number | null;
  /** Expected cash for both seats if offered at `ask`, after the 5% fee. */
  expectedKeep: number | null;
  /** True when the instant offer beats every ask this close to tip. */
  takeInstant: boolean;
  instantTotal: number | null;
  sentence: string;
};

export type PriceProjection = {
  enough: boolean;
  /** Blended per-seat price at tip. */
  price: number | null;
  low: number | null;
  high: number | null;
  sentence: string;
  /** True until the archive reaches the trust bar. */
  early: boolean;
  todayPrice: number | null;
  todayLow: number | null;
  todayHigh: number | null;
  suggestion: ListSuggestion | null;
};

export type MarketFit = {
  ok: true;
  version: string;
  knots: number[];
  terms: TermName[];
  beta: number[];
  xtxInv: number[][];
  sigma: number;
  sigmaGame: number;
  intercepts: Record<string, number>;
  counts: Record<string, number>;
  supplyMean: number;
  winRateMean: number;
  /** Mean log per-seat instant offer. Null until enough offers are logged. */
  instantMean: number | null;
  minLog: number;
  maxLog: number;
  rows: number;
  games: number;
  observedGames: number;
  early: boolean;
  blend: number;
};

export type FitFailure = {
  ok: false;
  version: string;
  rows: number;
  games: number;
  observedGames: number;
  reason: string;
};

export type FitResult = MarketFit | FitFailure;

type FitContext = {
  supplyMean: number;
  winRateMean: number;
  instantMean: number | null;
};

export function opponentTier(opponent: string, demand: string | null | undefined): OpponentTier {
  if (demand === "bigger") return "marquee";
  if (demand === "soft") return "soft";
  if (demand === "standard") return "standard";
  const name = opponent.trim().toLowerCase().replace(/\s+/g, " ");
  if (MARQUEE.has(name)) return "marquee";
  if (SOFT.has(name)) return "soft";
  return "standard";
}

export function isNationalTv(notes: string | null | undefined, explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const text = notes ?? "";
  return /\b(NBC|ESPN|TNT|ABC)\b/i.test(text) || /national[\s-]*tv/i.test(text);
}

export function isWeekendGame(weekday: string, date: string): boolean {
  const name = weekday.trim().toLowerCase();
  if (name.startsWith("sat") || name.startsWith("sun")) return true;
  if (/^(mon|tue|wed|thu|fri)/.test(name)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Restricted cubic spline, scaled so each column stays near a small number. */
export function daysOutBasis(daysOut: number, knots: readonly number[] = KNOTS): [number, number, number] {
  const x = Math.max(0, daysOut);
  const [t1 = 7, t2 = 21, t3 = 45, t4 = 90] = knots;
  const scale = Math.max(1, (t4 - t1) ** 3);
  return [x / 30, rcs(x, t1, t3, t4) / scale, rcs(x, t2, t3, t4) / scale];
}

/** Knots inside the days we have actually seen, so the curve is not asked to bend in empty space. */
export function knotsFromRows(rows: readonly MarketRow[]): number[] {
  const days = rows
    .map((row) => row.daysOut)
    .filter((daysOut) => Number.isFinite(daysOut) && daysOut >= 0)
    .sort((a, b) => a - b);
  const span = (days[days.length - 1] ?? 0) - (days[0] ?? 0);
  if (days.length < 12 || span < 21) return [...KNOTS];
  const picked = [0.05, 0.35, 0.65, 0.95].map((p) => quantile(days, p));
  const knots: number[] = [];
  for (const pick of picked) {
    const previous = knots[knots.length - 1];
    knots.push(previous == null ? pick : Math.max(pick, previous + 1));
  }
  return knots;
}

/**
 * How far the archive is toward the trust bar (most of a season of checks, or
 * about half the games played). Below 1 the projection says Early estimate. It no
 * longer weights the live middle against the model: today is always anchored to
 * the live middle (see projectGame).
 */
export function trustBlend(rows: number, observedGames: number): { early: boolean; blend: number } {
  const progress = Math.max(rows / TRUST_ROWS, observedGames / TRUST_OBSERVED_GAMES);
  const blend = Math.min(1, Math.max(0, progress));
  return { early: blend < 1, blend };
}

export function modelExplainer(): string {
  return [
    "It reads similar-seat prices for every home game, leaving out singles.",
    "Today's price is the latest middle of similar seats. It learns how each game's price moves as tip nears and carries today's price along that path.",
    "A game with no listings yet gets a price from similar games: opponent, weekend tips and national TV.",
    "Until there's most of a season of checks, the path to tip is an Early estimate.",
    "The goal is $6,000 after fees plus 15%. Each ask is the price that adds the most expected cash after the 5% fee. Sit games are left out.",
    "When the goal is at risk, asks lean toward selling; when it looks safe, they hold out.",
    "A pair that vanishes well before tip counts as a possible sale.",
    "A saved instant offer sets a floor. Within a week of tip, if a listing likely clears less, it says take the instant offer.",
    "These are suggestions only, and nothing is listed automatically.",
  ].join(" ");
}

export function fitMarketModel(
  rows: readonly MarketRow[],
  today = "9999-12-31",
  options?: { knots?: readonly number[] },
): FitResult {
  const clean = rows.filter(usableRow);
  const games = new Set(clean.map((row) => row.gameDate));
  const observedGames = countObserved(clean, today);
  if (clean.length < MIN_FIT_ROWS || games.size < MIN_FIT_GAMES) {
    return {
      ok: false,
      version: MODEL_VERSION,
      rows: clean.length,
      games: games.size,
      observedGames,
      reason: "not enough checks",
    };
  }

  const ctx = imputeContext(clean);
  const knots = options?.knots ? [...options.knots] : knotsFromRows(clean);
  const built = design(clean, ctx, knots);
  const solved = built ? solveTwoStage(built) : null;
  if (!built || !solved) {
    return {
      ok: false,
      version: MODEL_VERSION,
      rows: clean.length,
      games: games.size,
      observedGames,
      reason: "could not fit",
    };
  }

  const logs = built.y;
  const { early, blend } = trustBlend(clean.length, observedGames);

  return {
    ok: true,
    version: MODEL_VERSION,
    knots,
    terms: built.terms,
    beta: solved.beta,
    xtxInv: solved.xtxInv,
    sigma: solved.sigma,
    sigmaGame: solved.sigmaGame,
    intercepts: solved.intercepts,
    counts: solved.counts,
    supplyMean: ctx.supplyMean,
    winRateMean: ctx.winRateMean,
    instantMean: ctx.instantMean,
    minLog: Math.min(...logs),
    maxLog: Math.max(...logs),
    rows: clean.length,
    games: games.size,
    observedGames,
    early,
    blend,
  };
}

/**
 * Today's price is what similar seats list for now (the latest comp middle).
 * The fit only moves that price to tip along the shared days-out path, so a game
 * listed at $740 today is not pulled toward a model level fitted on other games.
 * A game with no listings at all gets the fit's price from similar games.
 */
export function projectGame(fit: FitResult, game: GameQuery): PriceProjection {
  // A tipped game already shows "Tip was N days ago", so it gets no sentence.
  if (game.daysOut < 0) return notEnough("");
  if (!fit.ok) return notEnough();

  const todayModel = predictPrice(fit, game, game.daysOut);
  const tipModel = predictPrice(fit, game, 0);
  if (!todayModel || !tipModel) return notEnough();
  const live = game.liveMedian != null && Number.isFinite(game.liveMedian) && game.liveMedian > 0 ? game.liveMedian : null;
  const shift = live == null ? 1 : live / todayModel.price;

  const today = bandAround(anchorToInstant(scaleBand(todayModel, shift), game.instantPerTicket));
  const tip = bandAround(anchorToInstant(scaleBand(tipModel, shift), game.instantPerTicket));
  const suggestion = suggestListPrice({
    predictedMedian: today.price,
    daysOut: game.daysOut,
    instantPerTicket: game.instantPerTicket,
    instantTotal: game.instantPerTicket != null && game.instantPerTicket > 0 ? game.instantPerTicket * PAIR_SEATS : null,
  });

  const lead =
    live == null
      ? `No similar seats are listed for this game yet. Similar games put it at about ${dollars(today.price)} today`
      : `Similar seats are about ${dollars(today.price)} today`;
  const sentence =
    `${lead} and about ${dollars(tip.price)} by tip. ` +
    `4 times in 5, game day lands between ${dollars(tip.low)} and ${dollars(tip.high)}.`;

  return {
    enough: true,
    price: tip.price,
    low: tip.low,
    high: tip.high,
    sentence,
    early: fit.early,
    todayPrice: today.price,
    todayLow: today.low,
    todayHigh: today.high,
    suggestion,
  };
}

/** Chance a pair at `ask` sells before tip. Falls as the ask rises over the middle. */
export function saleProbability(args: {
  ask: number;
  predictedMedian: number;
  daysOut: number;
  curve?: SaleCurve;
}): number {
  const median = args.predictedMedian;
  if (!Number.isFinite(args.ask) || args.ask <= 0 || !Number.isFinite(median) || median <= 0) return 0;
  const curve = args.curve ?? SALE_PRIORS;
  const [, logRatio, logDays] = saleFeatures(args.ask / median, args.daysOut);
  const logit = curve.intercept + curve.logRatio * logRatio + curve.logDays * logDays;
  return Math.min(MAX_SALE_CHANCE, 1 / (1 + Math.exp(-logit)));
}

function saleFeatures(ratio: number, daysOut: number): [number, number, number] {
  const days = Math.min(SALE_DAYS_CAP, Math.max(0, Number.isFinite(daysOut) ? daysOut : 0));
  return [1, Math.log(clampRatio(ratio)), Math.log(1 + days)];
}

function clampRatio(ratio: number): number {
  return Math.min(3, Math.max(0.25, ratio));
}

/** Asks from 70% to 150% of the fair price, one row per whole-dollar ask. */
export function askOffers(args: {
  predictedMedian: number;
  daysOut: number;
  curve?: SaleCurve;
}): AskOffer[] {
  const fair = args.predictedMedian;
  if (!Number.isFinite(fair) || fair <= 0) return [];
  const byAsk = new Map<number, AskOffer>();
  for (let step = 0; step <= 16; step += 1) {
    const ask = Math.max(1, Math.round(fair * (0.7 + step * 0.05)));
    const chance = saleProbability({
      ask,
      predictedMedian: fair,
      daysOut: args.daysOut,
      curve: args.curve,
    });
    const pair = ask * PAIR_SEATS * SELLER_KEEP_RATE;
    const offer: AskOffer = {
      ask,
      chance: Math.round(chance * 1000) / 1000,
      pair: Math.round(pair * 100) / 100,
      expected: Math.round(chance * pair * 100) / 100,
    };
    const prev = byAsk.get(ask);
    if (!prev || offer.expected > prev.expected) byAsk.set(ask, offer);
  }
  return [...byAsk.values()].sort((a, b) => a.ask - b.ask);
}

export function bestExpectedOffer(offers: readonly AskOffer[]): AskOffer | null {
  let best: AskOffer | null = null;
  for (const offer of offers) {
    if (!best || offer.expected > best.expected + 1e-9 || (Math.abs(offer.expected - best.expected) <= 1e-9 && offer.ask < best.ask)) {
      best = offer;
    }
  }
  return best;
}

export function suggestListPrice(args: {
  predictedMedian: number;
  daysOut: number;
  curve?: SaleCurve;
  instantTotal?: number | null;
  instantPerTicket?: number | null;
}): ListSuggestion {
  const guarded = offersNearTip(askOffers(args), args.instantTotal ?? null, args.daysOut);
  if (guarded.takeInstant && args.instantTotal != null) {
    const perTicket = args.instantPerTicket != null && args.instantPerTicket > 0 ? args.instantPerTicket : args.instantTotal / PAIR_SEATS;
    return takeInstantSuggestion(args.instantTotal, perTicket);
  }
  const best = bestExpectedOffer(guarded.offers);
  if (!best) return holdSuggestion("Not enough price data to suggest an ask yet.");
  return suggestionFromOffer(best);
}

/**
 * Close to tip, drop asks whose expected cash is under the guaranteed offer.
 * If every ask falls short, the suggestion is to take the instant offer.
 * No asks at all means there is no price to compare, so the offer stays a floor only.
 */
export function offersNearTip(
  offers: readonly AskOffer[],
  instantTotal: number | null,
  daysOut: number,
): { offers: AskOffer[]; takeInstant: boolean } {
  if (instantTotal == null || !(instantTotal > 0) || daysOut > NEAR_TIP_DAYS || offers.length === 0) {
    return { offers: [...offers], takeInstant: false };
  }
  const viable = offers.filter((offer) => offer.expected + 0.005 >= instantTotal);
  if (viable.length === 0) return { offers: [], takeInstant: true };
  return { offers: viable, takeInstant: false };
}

export function takeInstantSuggestion(total: number, perTicket: number): ListSuggestion {
  return {
    ask: null,
    hold: true,
    saleChance: null,
    expectedKeep: Math.round(total * 100) / 100,
    takeInstant: true,
    instantTotal: Math.round(total * 100) / 100,
    sentence: `Take the instant offer: ${exactDollars(total)} for the pair (${exactDollars(perTicket)} a seat). This close to tip, a listing likely won't beat it.`,
  };
}

export function suggestionFromOffer(offer: AskOffer): ListSuggestion {
  return {
    ask: offer.ask,
    hold: false,
    saleChance: offer.chance,
    expectedKeep: offer.expected,
    takeInstant: false,
    instantTotal: null,
    sentence: `Ask ${dollars(offer.ask)} a seat. The chance it sells before tip is ${formatChance(offer.chance)}, and the pair should bring about ${dollars(offer.expected)} after the 5% fee.`,
  };
}

export function sitSuggestion(sentence: string): ListSuggestion {
  return holdSuggestion(sentence);
}

export function soldSuggestion(banked: number): ListSuggestion {
  const cash = banked > 0 ? ` for ${dollars(banked)} after fees` : "";
  return holdSuggestion(`These seats sold${cash}.`);
}

const SAFER_BELOW = 0.4;
const PATIENT_ABOVE = 0.7;
const SAFER_KEEP = 0.82;
const PATIENT_KEEP = 0.88;
/** Pseudo-rows holding the fitted level and days term near the priors (a light ridge). */
const PRIOR_STRENGTH = 40;
const CALIBRATE_MIN_ROWS = 400;
const CALIBRATE_MIN_CLASS = 40;

export function seasonTarget(breakEven = SEASON_COST_DEFAULT, cushion = SEASON_CUSHION_DEFAULT): number {
  const base = Number.isFinite(breakEven) && breakEven > 0 ? breakEven : SEASON_COST_DEFAULT;
  const extra = Number.isFinite(cushion) && cushion >= 0 ? cushion : SEASON_CUSHION_DEFAULT;
  return Math.round(base * (1 + extra) * 100) / 100;
}

/**
 * Pick the ask with the most expected cash on each for-sale game, then lean
 * once. A low chance of clearing the goal prefers a higher-chance ask. A high
 * chance allows a higher ask. One pass, so the lean does not chase itself.
 */
export function planSeason(
  games: readonly CashGame[],
  options?: { breakEven?: number; cushion?: number },
): SeasonOutlook {
  const breakEven = options?.breakEven ?? SEASON_COST_DEFAULT;
  const cushion = options?.cushion ?? SEASON_CUSHION_DEFAULT;
  const target = seasonTarget(breakEven, cushion);
  const banked = round2(games.filter((game) => game.sold).reduce((sum, game) => sum + Math.max(0, game.banked), 0));
  const open = games.filter((game) => !game.sold && !game.keeping && game.offers.length > 0);
  const evPicks = new Map<string, AskOffer>();
  for (const game of open) {
    const best = bestExpectedOffer(game.offers);
    if (best) evPicks.set(game.date, best);
  }
  const evChance = clearChance(
    banked,
    target,
    [...evPicks.values()].map((offer) => ({ p: offer.chance, cash: offer.pair })),
  );
  const lean: SeasonLean = evChance < SAFER_BELOW ? "safer" : evChance > PATIENT_ABOVE ? "patient" : "even";
  const asks: Record<string, AskOffer> = {};
  for (const game of open) {
    const picked = evPicks.get(game.date);
    if (!picked) continue;
    asks[game.date] = tiltOffer(game.offers, picked, lean);
  }
  const chosen = Object.values(asks);
  const expectedRest = round2(chosen.reduce((sum, offer) => sum + offer.expected, 0));
  const chance = clearChance(
    banked,
    target,
    chosen.map((offer) => ({ p: offer.chance, cash: offer.pair })),
  );
  const outlook: SeasonOutlook = {
    breakEven,
    cushion,
    target,
    banked,
    expectedRest,
    expectedTotal: round2(banked + expectedRest),
    chance: Math.round(chance * 1000) / 1000,
    lean,
    forSale: games.filter((game) => !game.sold && !game.keeping).length,
    kept: games.filter((game) => !game.sold && game.keeping).length,
    priced: chosen.length,
    sentence: "",
    asks,
  };
  outlook.sentence = outlookSentence(outlook);
  return outlook;
}

export function withKeeping(games: readonly CashGame[], date: string, keeping: boolean): CashGame[] {
  return games.map((game) => (game.date === date && !game.sold ? { ...game, keeping } : game));
}

export function keepingSentence(current: SeasonOutlook, flipped: SeasonOutlook, keepingNow: boolean): string {
  const fromCash = dollars(current.expectedTotal);
  const toCash = dollars(flipped.expectedTotal);
  const fromChance = formatChance(current.chance);
  const toChance = formatChance(flipped.chance);
  const goal = fromChance === toChance ? `the goal chance stays at ${fromChance}` : `the goal chance goes from ${fromChance} to ${toChance}`;
  const move = `season cash goes from ${fromCash} to ${toCash}, and ${goal}.`;
  return keepingNow ? `This game is on Sit, so it's out of the cash plan. If you sell, ${move}` : `If you sit instead, ${move}`;
}

/** Chance the independent sale outcomes reach `target` after `banked` is counted. */
export function clearChance(banked: number, target: number, outcomes: readonly { p: number; cash: number }[]): number {
  const gap = Math.max(0, Math.ceil(target - Math.max(0, banked)));
  if (gap === 0) return 1;
  if (outcomes.length === 0) return 0;
  const capped = Math.min(gap, 20000);
  let prob = new Float64Array(capped + 1);
  prob[capped] = 1;
  for (const outcome of outcomes) {
    const next = new Float64Array(capped + 1);
    const cash = Math.max(0, Math.round(outcome.cash));
    const p = Math.min(1, Math.max(0, outcome.p));
    for (let remaining = 0; remaining <= capped; remaining += 1) {
      const weight = prob[remaining] ?? 0;
      if (weight === 0) continue;
      const afterSale = Math.max(0, remaining - cash);
      next[afterSale] = (next[afterSale] ?? 0) + weight * p;
      next[remaining] = (next[remaining] ?? 0) + weight * (1 - p);
    }
    prob = next;
  }
  return Math.min(1, Math.max(0, prob[0] ?? 0));
}

/**
 * A comparable pair that disappears between checks, more than a few days
 * before tip, is a possible sale. The same seats coming back at nearly the
 * same price are a price edit. Near-tip disappearances are left out.
 */
export function detectLikelySales(snaps: readonly CompSnap[]): ProbableSale[] {
  const cached = likelySalesCache.get(snaps);
  if (cached) return [...cached];
  const found = findLikelySales(snaps);
  likelySalesCache.set(snaps, found);
  return [...found];
}

// Pure in `snaps`; the fit, the snapshot and likely sales all ask for the same array.
const likelySalesCache = new WeakMap<readonly CompSnap[], ProbableSale[]>();

function findLikelySales(snaps: readonly CompSnap[]): ProbableSale[] {
  const byGame = new Map<string, CompSnap[]>();
  for (const snap of snaps) {
    if (snap.quantity < PAIR_SEATS) continue;
    if (!Number.isFinite(snap.price) || snap.price <= 0) continue;
    if (!Number.isFinite(snap.daysOut)) continue;
    const list = byGame.get(snap.gameDate) ?? [];
    list.push(snap);
    byGame.set(snap.gameDate, list);
  }

  const found: ProbableSale[] = [];
  for (const [gameDate, rows] of byGame) {
    const pulls = new Map<string, CompSnap[]>();
    for (const row of rows) {
      const id = `${row.etDate}|${row.pulledAt}`;
      const list = pulls.get(id) ?? [];
      list.push(row);
      pulls.set(id, list);
    }
    const ordered = [...pulls.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // Seat group -> [check index, price], so "do these seats come back later" reads one
    // group instead of every later listing (that scan was quadratic in checks per game).
    const bySeats = new Map<string, [number, number][]>();
    ordered.forEach(([, snaps], at) => {
      for (const snap of snaps) {
        const list = bySeats.get(seatsKey(snap)) ?? [];
        list.push([at, snap.price]);
        bySeats.set(seatsKey(snap), list);
      }
    });
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const earlier = ordered[index]?.[1] ?? [];
      const later = ordered[index + 1]?.[1] ?? [];
      const laterDays = later[0]?.daysOut ?? 0;
      if (laterDays <= LIKELY_SOLD_MIN_DAYS) continue;
      const laterCounts = countSnapKeys(later);
      const firstByKey = new Map<string, CompSnap>();
      for (const snap of earlier) {
        const key = snapKey(snap);
        if (!firstByKey.has(key)) firstByKey.set(key, snap);
      }
      for (const [key, count] of countSnapKeys(earlier)) {
        const gone = count - (laterCounts.get(key) ?? 0);
        if (gone <= 0) continue;
        const sample = firstByKey.get(key);
        if (!sample || seatsSeenAfter(sample, bySeats, index)) continue;
        const goneDate = later[0]?.etDate ?? sample.etDate;
        for (let copy = 0; copy < gone; copy += 1) {
          found.push({
            gameDate,
            seenDate: sample.etDate,
            goneDate,
            daysOut: laterDays,
            section: sample.section,
            row: sample.row,
            quantity: sample.quantity,
            price: sample.price,
            certain: false,
            externalId: `proxy|${gameDate}|${key}|${sample.etDate}|${goneDate}|${copy}`,
            median: sample.median,
            supply: sample.supply,
          });
        }
      }
    }
  }
  return found;
}

/**
 * How comparable pairs ended on games already played. For each played game, take
 * the first check of each ET day; the last day with a check before tip is the end.
 * Every pair on an earlier day is a row, `sold` when its seats (section, row,
 * quantity) are no longer listed at the end check. Seats still up at any price
 * did not sell at the price they had, so a price cut counts as unsold.
 */
export function saleOutcomeRows(snaps: readonly CompSnap[], today: string): SaleOutcomeRow[] {
  const byGameDay = new Map<string, Map<string, CompSnap[]>>();
  const firstPull = new Map<string, string>();
  for (const snap of snaps) {
    if (snap.gameDate >= today || snap.daysOut < 0) continue;
    if (snap.quantity < PAIR_SEATS || !(snap.price > 0)) continue;
    const dayKey = `${snap.gameDate}|${snap.etDate}`;
    const first = firstPull.get(dayKey);
    if (first != null && snap.pulledAt > first) continue;
    let days = byGameDay.get(snap.gameDate);
    if (!days) {
      days = new Map();
      byGameDay.set(snap.gameDate, days);
    }
    if (first == null || snap.pulledAt < first) {
      firstPull.set(dayKey, snap.pulledAt);
      days.set(snap.etDate, []);
    }
    days.get(snap.etDate)?.push(snap);
  }
  const rows: SaleOutcomeRow[] = [];
  for (const days of byGameDay.values()) {
    const ordered = [...days.keys()].sort();
    const stillUp = new Set((days.get(ordered[ordered.length - 1] ?? "") ?? []).map(seatsKey));
    for (const day of ordered.slice(0, -1)) {
      for (const snap of days.get(day) ?? []) {
        if (snap.median == null || !(snap.median > 0)) continue;
        rows.push({ sold: !stillUp.has(seatsKey(snap)), ratio: snap.price / snap.median, daysOut: snap.daysOut });
      }
    }
  }
  return rows;
}

/**
 * Fit the level and days term to the played-game rows (Newton steps on the
 * logistic log-likelihood with a light ridge toward the priors). The price slope
 * stays at the prior (see SALE_PRIORS). Too few rows, or too few of either
 * outcome, keeps the priors.
 */
export function calibrateSaleCurve(rows: readonly SaleOutcomeRow[], priors: SaleCurve = SALE_PRIORS): SaleCurve {
  const usable = rows.filter((row) => Number.isFinite(row.ratio) && row.ratio > 0 && Number.isFinite(row.daysOut));
  const sold = usable.reduce((sum, row) => sum + (row.sold ? 1 : 0), 0);
  if (usable.length < CALIBRATE_MIN_ROWS || sold < CALIBRATE_MIN_CLASS || usable.length - sold < CALIBRATE_MIN_CLASS) {
    return { ...priors };
  }
  // The set price slope enters as a fixed offset; only the level and days term move.
  const offset = usable.map((row) => priors.logRatio * saleFeatures(row.ratio, row.daysOut)[1]);
  const days = usable.map((row) => saleFeatures(row.ratio, row.daysOut)[2]);
  let level = priors.intercept;
  let slope = priors.logDays;
  for (let iter = 0; iter < 25; iter += 1) {
    let g0 = PRIOR_STRENGTH * (priors.intercept - level);
    let g1 = PRIOR_STRENGTH * (priors.logDays - slope);
    let h00 = PRIOR_STRENGTH;
    let h01 = 0;
    let h11 = PRIOR_STRENGTH;
    for (let index = 0; index < usable.length; index += 1) {
      const x = days[index] ?? 0;
      const eta = Math.min(30, Math.max(-30, level + slope * x + (offset[index] ?? 0)));
      const p = 1 / (1 + Math.exp(-eta));
      const resid = (usable[index]?.sold ? 1 : 0) - p;
      const w = p * (1 - p);
      g0 += resid;
      g1 += resid * x;
      h00 += w;
      h01 += w * x;
      h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) return { ...priors };
    const step0 = (h11 * g0 - h01 * g1) / det;
    const step1 = (h00 * g1 - h01 * g0) / det;
    level += step0;
    slope += step1;
    if (Math.abs(step0) < 1e-9 && Math.abs(step1) < 1e-9) break;
  }
  if (!Number.isFinite(level) || !Number.isFinite(slope)) return { ...priors };
  return { intercept: level, logRatio: priors.logRatio, logDays: slope };
}

/** Typical percent miss when each game’s latest check is left out of the fit. */
export function holdoutMedianAbsPercent(rows: readonly MarketRow[], today = "9999-12-31"): number | null {
  const byGame = new Map<string, MarketRow[]>();
  for (const row of rows) {
    if (!usableRow(row)) continue;
    const list = byGame.get(row.gameDate) ?? [];
    list.push(row);
    byGame.set(row.gameDate, list);
  }
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
  const fit = fitMarketModel(train, today);
  if (!fit.ok) return null;
  const errors: number[] = [];
  for (const row of held) {
    const predicted = predictPrice(fit, rowToQuery(row), row.daysOut);
    if (!predicted || row.median <= 0) continue;
    errors.push(Math.abs(predicted.price - row.median) / row.median);
  }
  if (errors.length < 5) return null;
  errors.sort((a, b) => a - b);
  const mid = errors.length % 2 === 1 ? errors[(errors.length - 1) / 2] : ((errors[errors.length / 2 - 1] ?? 0) + (errors[errors.length / 2] ?? 0)) / 2;
  if (mid == null) return null;
  return Math.round(mid * 1000) / 10;
}

export type StoredModelFit = {
  version: string;
  fittedAt: string;
  etDate: string;
  trigger: string;
  rows: number;
  games: number;
  observedGames: number;
  early: number;
  blend: number;
  sigma: number | null;
  sigmaGame: number | null;
  holdoutMedianAbsPercent: number | null;
  paramsJson: string;
};

export function storedModelFit(args: {
  fit: FitResult;
  holdoutMedianAbsPercent: number | null;
  fittedAt: string;
  etDate: string;
  trigger: string;
}): StoredModelFit {
  const { fit } = args;
  return {
    version: MODEL_VERSION,
    fittedAt: args.fittedAt,
    etDate: args.etDate,
    trigger: args.trigger,
    rows: fit.rows,
    games: fit.games,
    observedGames: fit.observedGames,
    early: fit.ok ? (fit.early ? 1 : 0) : 1,
    blend: fit.ok ? fit.blend : 0,
    sigma: fit.ok ? fit.sigma : null,
    sigmaGame: fit.ok ? fit.sigmaGame : null,
    holdoutMedianAbsPercent: args.holdoutMedianAbsPercent,
    paramsJson: JSON.stringify(fit),
  };
}

function rowToQuery(row: MarketRow): GameQuery {
  return {
    gameDate: row.gameDate,
    daysOut: row.daysOut,
    tier: row.tier,
    weekend: row.weekend,
    nationalTv: row.nationalTv,
    winRate: row.winRate,
    supply: row.supply,
    liveMedian: row.median,
    instantPerTicket: row.instantPerTicket ?? null,
  };
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

function countObserved(rows: readonly MarketRow[], today: string): number {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.gameDate <= today) seen.add(row.gameDate);
  }
  return seen.size;
}

function imputeContext(rows: readonly MarketRow[]): FitContext {
  const supplies: number[] = [];
  const rates: number[] = [];
  const instants: number[] = [];
  for (const row of rows) {
    if (row.supply != null && Number.isFinite(row.supply) && row.supply >= 0) supplies.push(Math.log(1 + row.supply));
    if (row.winRate != null && Number.isFinite(row.winRate)) rates.push(row.winRate);
    if (row.instantPerTicket != null && Number.isFinite(row.instantPerTicket) && row.instantPerTicket > 0) {
      instants.push(Math.log(row.instantPerTicket));
    }
  }
  return {
    supplyMean: supplies.length >= 8 ? average(supplies) : 0,
    winRateMean: rates.length >= 8 ? average(rates) : 0.5,
    instantMean: instants.length >= 8 ? average(instants) : null,
  };
}

type Design = {
  matrix: number[][];
  y: number[];
  terms: TermName[];
  gameDates: string[];
  /** Columns (into terms) that move within a game: the days-out path, supply. */
  within: number[];
  /** Columns fixed for a game: intercept, opponent tier, weekend, TV, ... */
  level: number[];
};

function design(rows: readonly MarketRow[], ctx: FitContext, knots: readonly number[]): Design | null {
  const full: number[][] = [];
  const y: number[] = [];
  const gameDates: string[] = [];
  for (const row of rows) {
    full.push(rawFeatures(row, ctx, knots));
    y.push(Math.log(row.median));
    gameDates.push(row.gameDate);
  }
  const groups = groupIndexes(gameDates);
  const terms: TermName[] = [];
  const within: number[] = [];
  const level: number[] = [];
  const keep: number[] = [];
  for (let column = 0; column < TERM_NAMES.length; column += 1) {
    const values = full.map((row) => row[column] ?? 0);
    const moves = column !== 0 && [...groups.values()].some((rowsOf) => columnSd(rowsOf.map((index) => values[index] ?? 0)) >= 1e-8);
    if (column !== 0 && !moves && columnSd(values) < 1e-8) continue;
    (moves ? within : level).push(keep.length);
    keep.push(column);
    terms.push(TERM_NAMES[column] as TermName);
  }
  if (within.length === 0) return null;
  const matrix = full.map((row) => keep.map((column) => row[column] ?? 0));
  return { matrix, y, terms, gameDates, within, level };
}

function groupIndexes(keys: readonly string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const list = groups.get(key) ?? [];
    list.push(index);
    groups.set(key, list);
  });
  return groups;
}

type TwoStage = {
  beta: number[];
  xtxInv: number[][];
  sigma: number;
  sigmaGame: number;
  intercepts: Record<string, number>;
  counts: Record<string, number>;
};

/**
 * Stage 1, within each game: how a game's own price moves with days out (and
 * supply), from each game's changes around its own average. Comparing games
 * with each other here would read "March games are pricier" as "prices fall as
 * tip nears", because each game is only seen over a few weeks.
 * Stage 2, between games: each game's level (its rows net of the stage-1 path)
 * on opponent tier, weekend, TV and win rate, which prices a game with no
 * listings. A game's own level is shrunk toward that by how many checks it has.
 */
function solveTwoStage(built: Design): TwoStage | null {
  const { matrix, y, gameDates, within, level } = built;
  const groups = groupIndexes(gameDates);
  const n = y.length;
  const demeanedX: number[][] = Array.from({ length: n }, () => Array(within.length).fill(0));
  const demeanedY: number[] = Array(n).fill(0);
  for (const rowsOf of groups.values()) {
    const meanY = average(rowsOf.map((index) => y[index] ?? 0));
    const meanX = within.map((column) => average(rowsOf.map((index) => matrix[index]?.[column] ?? 0)));
    for (const index of rowsOf) {
      demeanedY[index] = (y[index] ?? 0) - meanY;
      within.forEach((column, at) => {
        demeanedX[index]![at] = (matrix[index]?.[column] ?? 0) - (meanX[at] ?? 0);
      });
    }
  }
  const path = ols(demeanedX, demeanedY, 0);
  if (!path) return null;
  const gameCount = groups.size;
  let sse = 0;
  for (let index = 0; index < n; index += 1) {
    sse += ((demeanedY[index] ?? 0) - dot(demeanedX[index] ?? [], path.beta)) ** 2;
  }
  const sigma2 = sse / Math.max(1, n - gameCount - within.length);

  const dates = [...groups.keys()];
  const levels: number[] = [];
  const levelX: number[][] = [];
  const counts: Record<string, number> = {};
  for (const date of dates) {
    const rowsOf = groups.get(date) ?? [];
    counts[date] = rowsOf.length;
    levels.push(
      average(rowsOf.map((index) => (y[index] ?? 0) - within.reduce((sum, column, at) => sum + (matrix[index]?.[column] ?? 0) * (path.beta[at] ?? 0), 0))),
    );
    levelX.push(level.map((column) => matrix[rowsOf[0] ?? 0]?.[column] ?? 0));
  }
  // Too few games for every game-level term: keep the intercept only.
  const levelTerms = gameCount >= level.length + 2 ? level : level.slice(0, 1);
  const between = ols(
    levelX.map((row) => row.slice(0, levelTerms.length)),
    levels,
    1e-8,
  );
  if (!between) return null;
  const residuals = levels.map((value, index) => value - dot(levelX[index]?.slice(0, levelTerms.length) ?? [], between.beta));
  const levelVar = residuals.reduce((sum, value) => sum + value * value, 0) / Math.max(1, gameCount - levelTerms.length);
  const noise = average(dates.map((date) => sigma2 / Math.max(1, counts[date] ?? 1)));
  const sigmaGame2 = Math.max(0, levelVar - noise);
  const intercepts: Record<string, number> = {};
  dates.forEach((date, index) => {
    const weight = sigmaGame2 <= 0 ? 0 : sigmaGame2 / (sigmaGame2 + sigma2 / Math.max(1, counts[date] ?? 1));
    intercepts[date] = weight * (residuals[index] ?? 0);
  });

  const p = built.terms.length;
  const beta = Array(p).fill(0);
  const xtxInv = Array.from({ length: p }, () => Array(p).fill(0));
  within.forEach((column, at) => {
    beta[column] = path.beta[at] ?? 0;
    within.forEach((other, otherAt) => {
      xtxInv[column]![other] = path.xtxInv[at]?.[otherAt] ?? 0;
    });
  });
  // The level terms' spread is the between-game residual, written on the same sigma² scale.
  const scale = sigma2 > 0 ? levelVar / sigma2 : 0;
  levelTerms.forEach((column, at) => {
    beta[column] = between.beta[at] ?? 0;
    levelTerms.forEach((other, otherAt) => {
      xtxInv[column]![other] = (between.xtxInv[at]?.[otherAt] ?? 0) * scale;
    });
  });
  return { beta, xtxInv, sigma: Math.sqrt(Math.max(0, sigma2)), sigmaGame: Math.sqrt(sigmaGame2), intercepts, counts };
}

function rawFeatures(row: MarketRow, ctx: FitContext, knots: readonly number[]): number[] {
  const [days, curve1, curve2] = daysOutBasis(row.daysOut, knots);
  const win = row.winRate == null || !Number.isFinite(row.winRate) ? ctx.winRateMean : row.winRate;
  const supply =
    row.supply == null || !Number.isFinite(row.supply) || row.supply < 0
      ? ctx.supplyMean
      : Math.log(1 + row.supply);
  const instant =
    ctx.instantMean == null
      ? 0
      : row.instantPerTicket != null && Number.isFinite(row.instantPerTicket) && row.instantPerTicket > 0
        ? Math.log(row.instantPerTicket)
        : ctx.instantMean;
  return [
    1,
    days,
    curve1,
    curve2,
    row.tier === "marquee" ? 1 : 0,
    row.tier === "soft" ? 1 : 0,
    row.weekend ? 1 : 0,
    row.nationalTv ? 1 : 0,
    win,
    supply,
    instant,
  ];
}

function featuresFor(fit: MarketFit, game: GameQuery, daysOut: number): number[] {
  const ctx = { supplyMean: fit.supplyMean, winRateMean: fit.winRateMean, instantMean: fit.instantMean ?? null };
  const raw = rawFeatures(
    {
      gameDate: game.gameDate,
      snapshotDate: game.gameDate,
      daysOut,
      median: 1,
      tier: game.tier,
      weekend: game.weekend,
      nationalTv: game.nationalTv,
      winRate: game.winRate,
      supply: game.supply,
    },
    ctx,
    fit.knots,
  );
  const byName = new Map<TermName, number>();
  TERM_NAMES.forEach((name, index) => byName.set(name, raw[index] ?? 0));
  return fit.terms.map((name) => byName.get(name) ?? 0);
}

type Solved = { beta: number[]; xtxInv: number[][] };

function ols(matrix: number[][], y: number[], ridge = 1e-8): Solved | null {
  const n = y.length;
  const p = matrix[0]?.length ?? 0;
  if (n < p + 2 || p < 1) return null;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  for (let row = 0; row < n; row += 1) {
    const x = matrix[row] ?? [];
    for (let col = 0; col < p; col += 1) {
      xty[col] += (x[col] ?? 0) * (y[row] ?? 0);
      for (let other = col; other < p; other += 1) {
        const value = (x[col] ?? 0) * (x[other] ?? 0);
        xtx[col][other] += value;
        if (other !== col) xtx[other][col] += value;
      }
    }
  }
  for (let col = 0; col < p; col += 1) xtx[col][col] += Math.max(ridge, 1e-10);

  const beta = solveLinear(xtx, xty);
  if (!beta) return null;
  const xtxInv: number[][] = [];
  for (let col = 0; col < p; col += 1) {
    const basis = Array(p).fill(0);
    basis[col] = 1;
    const column = solveLinear(xtx, basis);
    if (!column) return null;
    xtxInv.push(column);
  }
  const inv = Array.from({ length: p }, (_, row) => xtxInv.map((column) => column[row] ?? 0));
  return { beta, xtxInv: inv };
}

function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const work = matrix.map((row, index) => [...row, vector[index] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(work[row]?.[col] ?? 0) > Math.abs(work[pivot]?.[col] ?? 0)) pivot = row;
    }
    if (Math.abs(work[pivot]?.[col] ?? 0) < 1e-10) return null;
    const swap = work[col];
    work[col] = work[pivot] as number[];
    work[pivot] = swap as number[];
    const scale = work[col]?.[col] ?? 1;
    for (let right = col; right <= n; right += 1) work[col][right] = (work[col][right] ?? 0) / scale;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = work[row]?.[col] ?? 0;
      if (factor === 0) continue;
      for (let right = col; right <= n; right += 1) {
        work[row][right] = (work[row][right] ?? 0) - factor * (work[col][right] ?? 0);
      }
    }
  }
  return work.map((row) => row[n] ?? 0);
}

function predictPrice(
  fit: MarketFit,
  game: GameQuery,
  daysOut: number,
): { price: number; low: number; high: number } | null {
  const x = featuresFor(fit, game, daysOut);
  if (x.length !== fit.beta.length) return null;
  let logMean = dot(x, fit.beta) + (fit.intercepts[game.gameDate] ?? 0);
  logMean = Math.min(fit.maxLog + LOG_CLAMP, Math.max(fit.minLog - LOG_CLAMP, logMean));
  if (!Number.isFinite(logMean)) return null;
  const count = fit.counts[game.gameDate] ?? 0;
  const sigma2 = fit.sigma * fit.sigma;
  const game2 = fit.sigmaGame * fit.sigmaGame;
  const postVar = game2 <= 0 ? 0 : count > 0 ? 1 / (count / Math.max(sigma2, 1e-12) + 1 / game2) : game2;
  const betaVar = Math.max(0, sigma2 * dot(x, matVec(fit.xtxInv, x)));
  // A wild standard error is a weak curve, not a real price range. Cap it so the page stays readable.
  const se = Math.min(0.75, Math.sqrt(Math.max(0, sigma2 + betaVar + postVar)));
  const price = Math.exp(logMean);
  const low = Math.exp(logMean - BAND_Z * se);
  const high = Math.exp(logMean + BAND_Z * se);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, low, high };
}

function scaleBand(
  band: { price: number; low: number; high: number },
  factor: number,
): { price: number; low: number; high: number } {
  return { price: band.price * factor, low: band.low * factor, high: band.high * factor };
}

function bandAround(band: { price: number; low: number; high: number }): {
  price: number;
  low: number;
  high: number;
} {
  const price = Math.max(1, Math.round(band.price));
  let low = Math.max(1, Math.round(band.low));
  let high = Math.max(1, Math.round(band.high));
  if (low > price) low = price;
  if (high < price) high = price;
  return { price, low, high };
}

function notEnough(sentence = NOT_ENOUGH_DATA): PriceProjection {
  return {
    enough: false,
    price: null,
    low: null,
    high: null,
    sentence,
    early: false,
    todayPrice: null,
    todayLow: null,
    todayHigh: null,
    suggestion: null,
  };
}

function holdSuggestion(sentence: string): ListSuggestion {
  return {
    ask: null,
    hold: true,
    saleChance: null,
    expectedKeep: null,
    takeInstant: false,
    instantTotal: null,
    sentence,
  };
}

/** Per-seat listing price implied by a guaranteed payout, after the 5% fee. */
export function impliedAsk(perTicket: number): number {
  if (!Number.isFinite(perTicket) || perTicket <= 0) return 0;
  return perTicket / SELLER_KEEP_RATE;
}

function anchorToInstant(
  band: { price: number; low: number; high: number },
  perTicket: number | null | undefined,
): { price: number; low: number; high: number } {
  const floor = impliedAsk(perTicket ?? 0);
  if (floor <= 0 || band.price >= floor) return band;
  return { price: floor, low: Math.min(band.low, floor), high: Math.max(band.high, floor) };
}

function exactDollars(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * The lean moves an ask at most LEAN_BAND from the most-expected-cash ask. With a
 * sale curve that falls smoothly with price, an unbounded tilt runs to the edge of
 * the ask range (70% or 150% of fair) on every game.
 */
const LEAN_BAND = 0.1;

function tiltOffer(offers: readonly AskOffer[], ev: AskOffer, lean: SeasonLean): AskOffer {
  const near = offers.filter((offer) => Math.abs(offer.ask - ev.ask) <= ev.ask * LEAN_BAND + 1e-9);
  if (lean === "safer") {
    const pool = near.filter((offer) => offer.chance + 1e-9 >= ev.chance && offer.expected + 1e-6 >= ev.expected * SAFER_KEEP);
    return pool.reduce<AskOffer | null>((best, offer) => {
      if (!best || offer.chance > best.chance + 1e-9 || (Math.abs(offer.chance - best.chance) <= 1e-9 && offer.ask < best.ask)) {
        return offer;
      }
      return best;
    }, null) ?? ev;
  }
  if (lean === "patient") {
    const pool = near.filter((offer) => offer.ask + 1e-9 >= ev.ask && offer.expected + 1e-6 >= ev.expected * PATIENT_KEEP);
    return pool.reduce<AskOffer | null>((best, offer) => (best == null || offer.ask > best.ask ? offer : best), null) ?? ev;
  }
  return ev;
}

function outlookSentence(outlook: SeasonOutlook): string {
  const unpriced = Math.max(0, outlook.forSale - outlook.priced);
  const missing = unpriced > 0 ? ` ${unpriced} for-sale ${unpriced === 1 ? "game has" : "games have"} no price yet and aren't counted.` : "";
  const lean =
    outlook.lean === "safer"
      ? "Goal at risk, so asks lean toward selling."
      : outlook.lean === "patient"
        ? "Goal looks safe, so asks hold out a little."
        : "Asks go for the most expected cash.";
  return `Goal: ${dollars(outlook.target)} after fees (${dollars(outlook.breakEven)} + ${Math.round(outlook.cushion * 100)}%). ${dollars(outlook.banked)} is in; ${outlook.priced} priced games should add about ${dollars(outlook.expectedRest)}, so about ${dollars(outlook.expectedTotal)} in all at the suggested asks. The chance of clearing the goal is ${formatChance(outlook.chance)}.${missing} ${lean}`;
}

function snapKey(snap: CompSnap): string {
  return `${snap.section}|${snap.row}|${snap.quantity}|${Math.round(snap.price * 100)}`;
}

function countSnapKeys(snaps: readonly CompSnap[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const snap of snaps) {
    const key = snapKey(snap);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Same section, row and quantity. */
function seatsKey(snap: CompSnap): string {
  return `${snap.section}|${snap.row}|${snap.quantity}`;
}

/** Within the price-edit band of the first price. */
function samePrice(price: number, other: number): boolean {
  if (price <= 0) return false;
  return Math.abs(other - price) / price <= PRICE_EDIT_BAND;
}

/** The same seats at nearly the same price in any check after `index`. */
function seatsSeenAfter(sample: CompSnap, bySeats: ReadonlyMap<string, [number, number][]>, index: number): boolean {
  return (bySeats.get(seatsKey(sample)) ?? []).some(([at, price]) => at > index && samePrice(sample.price, price));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const left = sorted[low] ?? 0;
  const right = sorted[high] ?? left;
  if (low === high) return left;
  return left * (high - index) + right * (index - low);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function columnSd(values: readonly number[]): number {
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
}

function matVec(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function rcs(x: number, knot: number, penultimate: number, last: number): number {
  const span = last - penultimate;
  if (span === 0) return 0;
  return cube(x - knot) - cube(x - penultimate) * ((last - knot) / span) + cube(x - last) * ((penultimate - knot) / span);
}

function cube(value: number): number {
  if (value <= 0) return 0;
  return value * value * value;
}
