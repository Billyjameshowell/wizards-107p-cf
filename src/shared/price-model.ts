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

export const MODEL_VERSION = "1";
export const NOT_ENOUGH_DATA = "Not enough data yet.";
/** A game needs this many daily checks before it gets a number. */
export const MIN_SNAPSHOTS = 5;
/** Cleaned game×day rows before the fit stands on its own. */
export const TRUST_ROWS = 800;
/** About half of a 43-game home slate. */
export const TRUST_OBSERVED_GAMES = 22;
export const HOME_SLATE = 43;
/** Break-even net plus this share. 15% of $6,000 is a $6,900 season goal. */
export const SEASON_CUSHION_DEFAULT = 0.15;
/** A vanished pair this many days before tip can count as a possible sale. */
export const LIKELY_SOLD_MIN_DAYS = 3;
/** Same section, row, and quantity within this price band is a price edit. */
export const PRICE_EDIT_BAND = 0.08;
/** 80% of a normal curve sits inside ± this many standard deviations. */
export const BAND_Z = 1.2815515655446004;

const MIN_FIT_ROWS = 24;
const MIN_FIT_GAMES = 4;
const KNOTS = [7, 21, 45, 90] as const;
const LOG_CLAMP = 0.8;

/**
 * Hand-set until vanished listings and fetched sales are thick enough to move it.
 * Higher asks and more competing seats lower the chance; more days left raise it.
 */
export const SALE_PRIORS = {
  intercept: -1.2,
  logRatio: -2.8,
  logDays: 0.45,
  logSupply: -0.35,
} as const;

export type SaleCurve = {
  intercept: number;
  logRatio: number;
  logDays: number;
  logSupply: number;
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

export type SaleSample = {
  sold: boolean;
  certain: boolean;
  ask: number;
  predictedMedian: number;
  daysOut: number;
  supply: number;
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

const MARQUEE = new Set([
  "boston celtics",
  "dallas mavericks",
  "denver nuggets",
  "golden state warriors",
  "los angeles lakers",
  "milwaukee bucks",
  "new york knicks",
  "oklahoma city thunder",
  "philadelphia 76ers",
  "san antonio spurs",
]);

const SOFT = new Set([
  "brooklyn nets",
  "charlotte hornets",
  "detroit pistons",
  "portland trail blazers",
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
};

export type GameQuery = {
  gameDate: string;
  daysOut: number;
  tier: OpponentTier;
  weekend: boolean;
  nationalTv: boolean;
  winRate: number | null;
  supply: number | null;
  snapshots: number;
  liveMedian: number | null;
};

export type ListSuggestion = {
  ask: number | null;
  hold: boolean;
  saleChance: number | null;
  /** Expected cash for both seats if offered at `ask`, after the 5% fee. */
  expectedKeep: number | null;
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

export function winRateOf(wins: number | null | undefined, losses: number | null | undefined): number | null {
  if (wins == null || losses == null) return null;
  if (!Number.isFinite(wins) || !Number.isFinite(losses) || wins < 0 || losses < 0) return null;
  const played = wins + losses;
  if (played <= 0) return null;
  return wins / played;
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

export function trustBlend(rows: number, observedGames: number): { early: boolean; blend: number } {
  const progress = Math.max(rows / TRUST_ROWS, observedGames / TRUST_OBSERVED_GAMES);
  const blend = Math.min(1, Math.max(0, progress));
  return { early: blend < 1, blend };
}

export function modelExplainer(): string {
  return [
    "The estimate looks at similar-seat prices for every home game, not just this one.",
    "Similar seats are sections 107, 108, 118, and 119, rows J through T, and only groups of at least two seats. A buyer of this pair compares those. Single seats are left out of the middle.",
    "It learns how those prices usually change as tip gets closer, then lets a hot or cold game sit a little above or below that path.",
    "Opponent, a weekend tip, a national TV game, and how many similar seats are for sale all nudge the number. The Wizards’ record does too, when that record is known.",
    "Until there is most of a season of checks, the number leans toward the latest middle of similar seats and is marked as an early estimate.",
    "A game with fewer than five checks says there is not enough data yet.",
    "The season goal is $6,000 after fees, plus a 15% cushion. Each suggested ask is the per-seat price that adds the most expected cash for the pair, after the 5% fee. Games marked Sit are left out of that plan.",
    "If the chance of clearing the goal is low, suggestions lean toward a price more likely to sell. If the chance is high, they can hold out for more.",
    "A pair that vanishes well before tip is treated as a possible sale, not a sure one. Those notes slowly shape the chance of a sale.",
    "It is only a suggestion. Nothing is listed for you.",
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
  if (!built) {
    return {
      ok: false,
      version: MODEL_VERSION,
      rows: clean.length,
      games: games.size,
      observedGames,
      reason: "could not fit",
    };
  }

  const solved = ols(built.matrix, built.y);
  if (!solved) {
    return {
      ok: false,
      version: MODEL_VERSION,
      rows: clean.length,
      games: games.size,
      observedGames,
      reason: "could not fit",
    };
  }

  const residuals = built.y.map((value, index) => value - dot(built.matrix[index] ?? [], solved.beta));
  const shrunk = shrinkGames(built.gameDates, residuals, solved.beta.length);
  const logs = built.y;
  const { early, blend } = trustBlend(clean.length, observedGames);

  return {
    ok: true,
    version: MODEL_VERSION,
    knots,
    terms: built.terms,
    beta: solved.beta,
    xtxInv: solved.xtxInv,
    sigma: shrunk.sigma,
    sigmaGame: shrunk.sigmaGame,
    intercepts: shrunk.intercepts,
    counts: shrunk.counts,
    supplyMean: ctx.supplyMean,
    winRateMean: ctx.winRateMean,
    minLog: Math.min(...logs),
    maxLog: Math.max(...logs),
    rows: clean.length,
    games: games.size,
    observedGames,
    early,
    blend,
  };
}

export function projectGame(fit: FitResult, game: GameQuery): PriceProjection {
  if (!fit.ok) return notEnough(game.daysOut < 0 ? "This game has already tipped." : NOT_ENOUGH_DATA);
  if (game.daysOut < 0) return notEnough("This game has already tipped.");
  if (game.snapshots < MIN_SNAPSHOTS) return notEnough();

  const todayRaw = predictPrice(fit, game, game.daysOut);
  const tipRaw = predictPrice(fit, game, 0);
  if (!todayRaw || !tipRaw) return notEnough();

  const today = bandAround(blendTowardLive(todayRaw, game.liveMedian, fit.blend));
  const tip = bandAround(blendTowardLive(tipRaw, game.liveMedian, fit.blend));
  const suggestion = suggestListPrice({
    predictedMedian: today.price,
    daysOut: game.daysOut,
    supply: game.supply ?? 0,
  });

  const earlyLead = fit.early ? "Early estimate. " : "";
  const sentence =
    `${earlyLead}Similar seats look like about ${dollars(today.price)} today, and about ${dollars(tip.price)} by tip. ` +
    `About 4 times out of 5, the game-day price lands between ${dollars(tip.low)} and ${dollars(tip.high)}.`;

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

export function saleProbability(args: {
  ask: number;
  predictedMedian: number;
  daysOut: number;
  supply: number;
  curve?: SaleCurve;
}): number {
  const median = args.predictedMedian;
  if (!Number.isFinite(args.ask) || args.ask <= 0 || !Number.isFinite(median) || median <= 0) return 0;
  const curve = args.curve ?? SALE_PRIORS;
  const ratio = Math.min(3, Math.max(0.25, args.ask / median));
  const days = Math.max(0, args.daysOut);
  const supply = Math.max(0, args.supply);
  const logit =
    curve.intercept +
    curve.logRatio * Math.log(ratio) +
    curve.logDays * Math.log(1 + days) +
    curve.logSupply * Math.log(1 + supply);
  return 1 / (1 + Math.exp(-logit));
}

/** Asks from 70% to 150% of the fair price, one row per whole-dollar ask. */
export function askOffers(args: {
  predictedMedian: number;
  daysOut: number;
  supply: number;
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
      supply: args.supply,
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
  supply: number;
  curve?: SaleCurve;
}): ListSuggestion {
  const best = bestExpectedOffer(askOffers(args));
  if (!best) return holdSuggestion("Not enough of a price to suggest an ask. Nothing is listed for you.");
  return suggestionFromOffer(best);
}

export function suggestionFromOffer(offer: AskOffer, lean?: SeasonLean): ListSuggestion {
  const chancePct = Math.round(offer.chance * 100);
  const leanBit =
    lean === "safer"
      ? " The season chance is low, so this leans toward a price more likely to sell."
      : lean === "patient"
        ? " The season chance is high, so this can hold out for a little more."
        : "";
  return {
    ask: offer.ask,
    hold: false,
    saleChance: offer.chance,
    expectedKeep: offer.expected,
    sentence: `Suggested ask: ${dollars(offer.ask)} a seat. The rough chance of a sale before tip is ${chancePct}%. Expected cash for the pair, after the 5% fee, is about ${dollars(offer.expected)}.${leanBit} This is only a suggestion. Nothing is listed for you.`,
  };
}

export function sitSuggestion(sentence: string): ListSuggestion {
  return holdSuggestion(sentence);
}

export function soldSuggestion(banked: number): ListSuggestion {
  const cash = banked > 0 ? `, about ${dollars(banked)} after fees` : "";
  return holdSuggestion(`These seats are already sold${cash}. Nothing is listed for you.`);
}

const SAFER_BELOW = 0.4;
const PATIENT_ABOVE = 0.7;
const SAFER_KEEP = 0.82;
const PATIENT_KEEP = 0.88;
const PRIOR_STRENGTH = 80;
const CALIBRATE_MIN_ROWS = 40;
const CALIBRATE_MIN_CLASS = 8;

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
  const fromChance = Math.round(current.chance * 100);
  const toChance = Math.round(flipped.chance * 100);
  if (keepingNow) {
    return `These seats are marked Sit, so they stay out of the cash plan. Marking this game Sell would move expected season cash from ${fromCash} to ${toCash}, and the chance of clearing the goal from ${fromChance}% to ${toChance}%. Nothing is listed for you.`;
  }
  return `Marking this game Sit would move expected season cash from ${fromCash} to ${toCash}, and the chance of clearing the goal from ${fromChance}% to ${toChance}%. Nothing is listed for you.`;
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
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const earlier = ordered[index]?.[1] ?? [];
      const later = ordered[index + 1]?.[1] ?? [];
      const laterDays = later[0]?.daysOut ?? 0;
      if (laterDays <= LIKELY_SOLD_MIN_DAYS) continue;
      const laterCounts = countSnapKeys(later);
      const future = ordered.slice(index + 1).flatMap((entry) => entry[1]);
      for (const [key, count] of countSnapKeys(earlier)) {
        const gone = count - (laterCounts.get(key) ?? 0);
        if (gone <= 0) continue;
        const sample = earlier.find((snap) => snapKey(snap) === key);
        if (!sample || sameSeatsReturn(sample, future)) continue;
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

/** Positives are possible or sure sales. Negatives are pairs still up close to tip. */
export function saleSamples(snaps: readonly CompSnap[], certain: readonly ProbableSale[] = []): SaleSample[] {
  const samples: SaleSample[] = [];
  for (const sale of detectLikelySales(snaps)) {
    const sample = sampleFromSale(sale, false);
    if (sample) samples.push(sample);
  }
  for (const sale of certain) {
    if (!sale.certain) continue;
    const sample = sampleFromSale(sale, true);
    if (sample) samples.push(sample);
  }

  const byGame = new Map<string, CompSnap[]>();
  for (const snap of snaps) {
    if (snap.quantity < PAIR_SEATS || snap.price <= 0) continue;
    const list = byGame.get(snap.gameDate) ?? [];
    list.push(snap);
    byGame.set(snap.gameDate, list);
  }
  for (const rows of byGame.values()) {
    const pulls = new Map<string, CompSnap[]>();
    for (const row of rows) {
      const list = pulls.get(`${row.etDate}|${row.pulledAt}`) ?? [];
      list.push(row);
      pulls.set(`${row.etDate}|${row.pulledAt}`, list);
    }
    const ordered = [...pulls.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const seen = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index]?.[1] ?? [];
      const daysOut = current[0]?.daysOut ?? 99;
      if (daysOut < 0 || daysOut > LIKELY_SOLD_MIN_DAYS) continue;
      const earlier = ordered.slice(0, index).flatMap((entry) => entry[1]);
      for (const snap of current) {
        if (snap.median == null || snap.median <= 0) continue;
        if (!earlier.some((past) => sameSeats(snap, past))) continue;
        const id = `${snap.gameDate}|${snap.section}|${snap.row}|${snap.quantity}|${Math.round(snap.price * 100)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        samples.push({
          sold: false,
          certain: false,
          ask: snap.price,
          predictedMedian: snap.median,
          daysOut: snap.daysOut,
          supply: snap.supply ?? 0,
        });
      }
    }
  }
  return samples;
}

export function calibrateSaleCurve(samples: readonly SaleSample[], priors: SaleCurve = SALE_PRIORS): SaleCurve {
  const rows = samples.filter(
    (sample) =>
      sample.ask > 0 &&
      sample.predictedMedian > 0 &&
      Number.isFinite(sample.daysOut) &&
      Number.isFinite(sample.supply),
  );
  const positives = rows.filter((sample) => sample.sold).length;
  if (rows.length < CALIBRATE_MIN_ROWS || positives < CALIBRATE_MIN_CLASS || rows.length - positives < CALIBRATE_MIN_CLASS) {
    return { ...priors };
  }

  const features = rows.map((sample) => saleFeatures(sample));
  const outcomes = rows.map((sample) => (sample.sold ? 1 : 0));
  const baseWeight = rows.map((sample) => (sample.certain ? 2 : 1));
  let beta = [priors.intercept, priors.logRatio, priors.logDays, priors.logSupply];
  for (let iter = 0; iter < 12; iter += 1) {
    const target: number[] = [];
    const weight: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const eta = Math.min(12, Math.max(-12, dot(features[index] ?? [], beta)));
      const chance = 1 / (1 + Math.exp(-eta));
      const variance = Math.max(1e-4, chance * (1 - chance));
      target.push(eta + ((outcomes[index] ?? 0) - chance) / variance);
      weight.push((baseWeight[index] ?? 1) * variance);
    }
    const solved = weightedSolve(features, target, weight);
    if (!solved) return { ...priors };
    beta = solved;
  }
  if (beta.some((value) => !Number.isFinite(value))) return { ...priors };

  const weightSum = baseWeight.reduce((sum, value) => sum + value, 0);
  const prior = [priors.intercept, priors.logRatio, priors.logDays, priors.logSupply];
  const shrunk = beta.map((value, index) => (weightSum * value + PRIOR_STRENGTH * (prior[index] ?? 0)) / (weightSum + PRIOR_STRENGTH));
  return {
    intercept: shrunk[0] ?? priors.intercept,
    logRatio: shrunk[1] ?? priors.logRatio,
    logDays: shrunk[2] ?? priors.logDays,
    logSupply: shrunk[3] ?? priors.logSupply,
  };
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
    snapshots: MIN_SNAPSHOTS,
    liveMedian: row.median,
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
  for (const row of rows) {
    if (row.supply != null && Number.isFinite(row.supply) && row.supply >= 0) supplies.push(Math.log(1 + row.supply));
    if (row.winRate != null && Number.isFinite(row.winRate)) rates.push(row.winRate);
  }
  return {
    supplyMean: supplies.length >= 8 ? average(supplies) : 0,
    winRateMean: rates.length >= 8 ? average(rates) : 0.5,
  };
}

function design(
  rows: readonly MarketRow[],
  ctx: FitContext,
  knots: readonly number[],
): { matrix: number[][]; y: number[]; terms: TermName[]; gameDates: string[] } | null {
  const full: number[][] = [];
  const y: number[] = [];
  const gameDates: string[] = [];
  for (const row of rows) {
    full.push(rawFeatures(row, ctx, knots));
    y.push(Math.log(row.median));
    gameDates.push(row.gameDate);
  }
  const keep: number[] = [];
  for (let column = 0; column < TERM_NAMES.length; column += 1) {
    if (column === 0 || columnSd(full.map((row) => row[column] ?? 0)) >= 1e-8) keep.push(column);
  }
  if (keep.length < 2) return null;
  const matrix = full.map((row) => keep.map((column) => row[column] ?? 0));
  const terms = keep.map((column) => TERM_NAMES[column] as TermName);
  return { matrix, y, terms, gameDates };
}

function rawFeatures(row: MarketRow, ctx: FitContext, knots: readonly number[]): number[] {
  const [days, curve1, curve2] = daysOutBasis(row.daysOut, knots);
  const win = row.winRate == null || !Number.isFinite(row.winRate) ? ctx.winRateMean : row.winRate;
  const supply =
    row.supply == null || !Number.isFinite(row.supply) || row.supply < 0
      ? ctx.supplyMean
      : Math.log(1 + row.supply);
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
  ];
}

function featuresFor(fit: MarketFit, game: GameQuery, daysOut: number): number[] {
  const ctx = { supplyMean: fit.supplyMean, winRateMean: fit.winRateMean };
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

function ols(matrix: number[][], y: number[]): Solved | null {
  const n = y.length;
  const p = matrix[0]?.length ?? 0;
  if (n < p + 2 || p < 2) return null;
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
  for (let col = 0; col < p; col += 1) xtx[col][col] += 1e-8;

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

function shrinkGames(
  gameDates: readonly string[],
  residuals: readonly number[],
  parameters: number,
): { sigma: number; sigmaGame: number; intercepts: Record<string, number>; counts: Record<string, number> } {
  const grouped = new Map<string, number[]>();
  for (let index = 0; index < residuals.length; index += 1) {
    const date = gameDates[index] ?? "";
    const list = grouped.get(date) ?? [];
    list.push(residuals[index] ?? 0);
    grouped.set(date, list);
  }
  const counts: Record<string, number> = {};
  const means: Record<string, number> = {};
  let sse = 0;
  let n = 0;
  for (const [date, values] of grouped) {
    const mean = average(values);
    counts[date] = values.length;
    means[date] = mean;
    n += values.length;
    for (const value of values) sse += (value - mean) ** 2;
  }
  const games = grouped.size;
  const sigma2 = games > 0 && n > games ? sse / (n - games) : sse / Math.max(1, n - parameters);
  let weighted = 0;
  let sumSq = 0;
  for (const [date, count] of Object.entries(counts)) {
    weighted += count * (means[date] ?? 0);
    sumSq += count * count;
  }
  const grand = n > 0 ? weighted / n : 0;
  let between = 0;
  for (const [date, count] of Object.entries(counts)) {
    between += count * ((means[date] ?? 0) - grand) ** 2;
  }
  const n0denom = games > 1 ? n - sumSq / n : 0;
  const sigmaGame2 = games > 1 && n0denom > 0 ? Math.max(0, (between - (games - 1) * sigma2) / n0denom) : 0;
  const intercepts: Record<string, number> = {};
  for (const [date, count] of Object.entries(counts)) {
    const weight = sigmaGame2 <= 0 ? 0 : sigmaGame2 / (sigmaGame2 + sigma2 / count);
    intercepts[date] = weight * ((means[date] ?? 0) - grand);
  }
  return {
    sigma: Math.sqrt(Math.max(0, sigma2)),
    sigmaGame: Math.sqrt(sigmaGame2),
    intercepts,
    counts,
  };
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

function blendTowardLive(
  band: { price: number; low: number; high: number },
  live: number | null,
  weight: number,
): { price: number; low: number; high: number } {
  if (live == null || !Number.isFinite(live) || live <= 0 || weight >= 0.999) return band;
  const mix = Math.min(1, Math.max(0, weight));
  const price = Math.exp((1 - mix) * Math.log(live) + mix * Math.log(band.price));
  const lowRatio = band.low / band.price;
  const highRatio = band.high / band.price;
  const low = Math.min(price * lowRatio, live, band.low);
  const high = Math.max(price * highRatio, live, band.high);
  return { price, low, high };
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
    sentence,
  };
}

function tiltOffer(offers: readonly AskOffer[], ev: AskOffer, lean: SeasonLean): AskOffer {
  if (lean === "safer") {
    const pool = offers.filter((offer) => offer.chance + 1e-9 >= ev.chance && offer.expected + 1e-6 >= ev.expected * SAFER_KEEP);
    return pool.reduce<AskOffer | null>((best, offer) => {
      if (!best || offer.chance > best.chance + 1e-9 || (Math.abs(offer.chance - best.chance) <= 1e-9 && offer.ask < best.ask)) {
        return offer;
      }
      return best;
    }, null) ?? ev;
  }
  if (lean === "patient") {
    const pool = offers.filter((offer) => offer.ask + 1e-9 >= ev.ask && offer.expected + 1e-6 >= ev.expected * PATIENT_KEEP);
    return pool.reduce<AskOffer | null>((best, offer) => (best == null || offer.ask > best.ask ? offer : best), null) ?? ev;
  }
  return ev;
}

function outlookSentence(outlook: SeasonOutlook): string {
  const goal = `${dollars(outlook.breakEven)} plus ${Math.round(outlook.cushion * 100)}%, so ${dollars(outlook.target)} after fees`;
  const unpriced = Math.max(0, outlook.forSale - outlook.priced);
  const missing = unpriced > 0 ? ` ${unpriced} for-sale games have no price yet, so they are not in this total.` : "";
  const lean =
    outlook.lean === "safer"
      ? "The chance of clearing the goal is low, so suggestions lean toward prices more likely to sell."
      : outlook.lean === "patient"
        ? "The chance of clearing the goal is high, so suggestions can hold out for more."
        : "Suggestions follow the ask with the most expected cash.";
  return `Season goal is ${goal}. ${dollars(outlook.banked)} is already in from sold games. ${outlook.priced} for-sale games have a price to plan from and are expected to bring about ${dollars(outlook.expectedRest)}, about ${dollars(outlook.expectedTotal)} in all.${missing} The chance of clearing ${dollars(outlook.target)} is about ${Math.round(outlook.chance * 100)}%. ${lean} Nothing is listed for you.`;
}

function sampleFromSale(sale: ProbableSale, certain: boolean): SaleSample | null {
  if (sale.median == null || sale.median <= 0 || sale.price <= 0) return null;
  return {
    sold: true,
    certain,
    ask: sale.price,
    predictedMedian: sale.median,
    daysOut: sale.daysOut,
    supply: sale.supply ?? 0,
  };
}

function saleFeatures(sample: SaleSample): number[] {
  const ratio = Math.min(3, Math.max(0.25, sample.ask / sample.predictedMedian));
  return [1, Math.log(ratio), Math.log(1 + Math.max(0, sample.daysOut)), Math.log(1 + Math.max(0, sample.supply))];
}

function weightedSolve(features: readonly (readonly number[])[], target: readonly number[], weight: readonly number[]): number[] | null {
  const width = 4;
  const normal = Array.from({ length: width }, () => Array(width).fill(0));
  const right = Array(width).fill(0);
  for (let row = 0; row < features.length; row += 1) {
    const x = features[row] ?? [];
    const w = weight[row] ?? 0;
    for (let col = 0; col < width; col += 1) {
      right[col] += w * (x[col] ?? 0) * (target[row] ?? 0);
      for (let other = 0; other < width; other += 1) {
        normal[col][other] += w * (x[col] ?? 0) * (x[other] ?? 0);
      }
    }
  }
  for (let col = 0; col < width; col += 1) normal[col][col] += 1e-6;
  return solveLinear(normal, right);
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

function sameSeats(left: CompSnap, right: CompSnap): boolean {
  if (left.section !== right.section || left.row !== right.row || left.quantity !== right.quantity) return false;
  if (left.price <= 0) return false;
  return Math.abs(right.price - left.price) / left.price <= PRICE_EDIT_BAND;
}

function sameSeatsReturn(sample: CompSnap, future: readonly CompSnap[]): boolean {
  return future.some((snap) => sameSeats(sample, snap));
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
