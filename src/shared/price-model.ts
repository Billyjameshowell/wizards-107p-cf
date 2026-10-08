/**
 * Stage A fair price and Stage B list suggestion.
 *
 * Stage A fits log(comparable median) with plain least squares:
 * a shared natural cubic spline of days until tip, fixed effects, and a
 * per-game intercept shrunk toward the pack. Stage B scores candidate asks
 * with a hand-set sale curve. Nothing here lists a ticket.
 *
 * Swap the sale curve later when our own sales exist. Keep `fitMarketModel`
 * and `projectGame` as the call shape.
 */

import { PAIR_SEATS, SELLER_KEEP_RATE } from "./book";

export const MODEL_VERSION = "1";
export const NOT_ENOUGH_DATA = "Not enough data yet.";
/** A game needs this many daily checks before it gets a number. */
export const MIN_SNAPSHOTS = 5;
/** Cleaned game×day rows before the fit stands on its own. */
export const TRUST_ROWS = 800;
/** About half of a 43-game home slate. */
export const TRUST_OBSERVED_GAMES = 22;
export const HOME_SLATE = 43;
/** Default value of going, until a per-game number is saved. */
export const DEFAULT_ATTEND_VALUE = 0;
/** 80% of a normal curve sits inside ± this many standard deviations. */
export const BAND_Z = 1.2815515655446004;

const MIN_FIT_ROWS = 24;
const MIN_FIT_GAMES = 4;
const KNOTS = [7, 21, 45, 90] as const;
const LOG_CLAMP = 0.8;

/**
 * Hand-set until we have our own sales. Higher asks and more competing
 * seats lower the chance; more days left raise it. Kept conservative.
 */
export const SALE_PRIORS = {
  intercept: -1.2,
  logRatio: -2.8,
  logDays: 0.45,
  logSupply: -0.35,
} as const;

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
  attendValue?: number;
};

export type ListSuggestion = {
  ask: number | null;
  hold: boolean;
  saleChance: number | null;
  /** Expected cash for both seats if listed at `ask`, after the 5% fee. */
  expectedKeep: number | null;
  attendValue: number;
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
    "It learns how those prices usually change as tip gets closer, then lets a hot or cold game sit a little above or below that path.",
    "Opponent, a weekend tip, a national TV game, and how many similar seats are listed all nudge the number. The Wizards’ record does too, when that record is known.",
    "Until there is most of a season of checks, the number leans toward the latest middle of similar seats and is marked as an early estimate.",
    "A game with fewer than five checks says there is not enough data yet.",
    "The suggested ask is a separate guess at a price that might sell, after the 5% fee, weighed against what the night is worth if you go. The chance of a sale is a rough stand-in until our own sales are known.",
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

  const attend = finiteOr(game.attendValue, DEFAULT_ATTEND_VALUE);
  const todayRaw = predictPrice(fit, game, game.daysOut);
  const tipRaw = predictPrice(fit, game, 0);
  if (!todayRaw || !tipRaw) return notEnough();

  const today = bandAround(blendTowardLive(todayRaw, game.liveMedian, fit.blend));
  const tip = bandAround(blendTowardLive(tipRaw, game.liveMedian, fit.blend));
  const suggestion = suggestListPrice({
    predictedMedian: today.price,
    daysOut: game.daysOut,
    supply: game.supply ?? 0,
    attendValue: attend,
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
}): number {
  const median = args.predictedMedian;
  if (!Number.isFinite(args.ask) || args.ask <= 0 || !Number.isFinite(median) || median <= 0) return 0;
  const ratio = Math.min(3, Math.max(0.25, args.ask / median));
  const days = Math.max(0, args.daysOut);
  const supply = Math.max(0, args.supply);
  const logit =
    SALE_PRIORS.intercept +
    SALE_PRIORS.logRatio * Math.log(ratio) +
    SALE_PRIORS.logDays * Math.log(1 + days) +
    SALE_PRIORS.logSupply * Math.log(1 + supply);
  return 1 / (1 + Math.exp(-logit));
}

export function suggestListPrice(args: {
  predictedMedian: number;
  daysOut: number;
  supply: number;
  attendValue?: number;
}): ListSuggestion {
  const attend = finiteOr(args.attendValue, DEFAULT_ATTEND_VALUE);
  const fair = args.predictedMedian;
  if (!Number.isFinite(fair) || fair <= 0) {
    return holdSuggestion(attend, "Not enough of a price to suggest an ask. Nothing is listed for you.");
  }

  let bestAsk = Math.max(1, Math.round(fair));
  let bestChance = 0;
  let bestNet = attend;
  for (let step = 0; step <= 10; step += 1) {
    const ratio = 0.8 + step * 0.05;
    const ask = Math.max(1, Math.round(fair * ratio));
    const chance = saleProbability({
      ask,
      predictedMedian: fair,
      daysOut: args.daysOut,
      supply: args.supply,
    });
    const net = chance * ask * PAIR_SEATS * SELLER_KEEP_RATE + (1 - chance) * attend;
    if (net > bestNet + 1e-9 || (Math.abs(net - bestNet) <= 1e-9 && ask < bestAsk)) {
      bestNet = net;
      bestAsk = ask;
      bestChance = chance;
    }
  }

  if (bestNet <= attend + 0.5) {
    const worth = attend > 0 ? ` if this night is worth ${dollars(attend)} to you` : "";
    return holdSuggestion(attend, `Keeping the seats looks better than listing them${worth}. Nothing is listed for you.`);
  }

  const chancePct = Math.round(bestChance * 100);
  return {
    ask: bestAsk,
    hold: false,
    saleChance: Math.round(bestChance * 1000) / 1000,
    expectedKeep: Math.round(bestNet * 100) / 100,
    attendValue: attend,
    sentence: `Suggested ask: ${dollars(bestAsk)} a seat. The rough chance of a sale before tip is ${chancePct}%. This is only a suggestion. Nothing is listed for you.`,
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

function holdSuggestion(attend: number, sentence: string): ListSuggestion {
  return {
    ask: null,
    hold: true,
    saleChance: null,
    expectedKeep: null,
    attendValue: attend,
    sentence,
  };
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
