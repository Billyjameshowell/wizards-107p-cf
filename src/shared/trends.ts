import { finiteNumber } from "./archive";
import {
  extractSectionNumber,
  isCompListing,
  keepFromTypeIn,
  normalizeRow,
  pairFromTypeIn,
  roundMoney,
  SEASON_COST_DEFAULT,
  type CompListing,
} from "./book";
import {
  askOffers,
  calibrateSaleCurve,
  detectLikelySales,
  fitMarketModel,
  isNationalTv,
  isWeekendGame,
  keepingSentence,
  modelExplainer,
  NOT_ENOUGH_DATA,
  planSeason,
  projectGame,
  saleSamples,
  SEASON_CUSHION_DEFAULT,
  sitSuggestion,
  soldSuggestion,
  suggestionFromOffer,
  withKeeping,
  opponentTier,
  type AskOffer,
  type CashGame,
  type CompSnap,
  type MarketRow,
  type PriceProjection,
  type ProbableSale,
  type SeasonOutlook,
} from "./price-model";
import { daysUntil, suggestFromMedian, type Demand } from "./pricing";

/**
 * Public price trends. Aggregates only: no raw pulls, listings, or payloads.
 * Similar seats match the book: sections 107, 108, 118, and 119, rows J–T,
 * at least two seats. Arena-wide prices are left out.
 */

export const SIMILAR_SEATS = "Sections 107, 108, 118, and 119, rows J through T";

/** Cheapest has to be at least this share of the median or it is an arena floor, not a similar seat. */
const CHEAPEST_FLOOR = 0.25;

const RANK = { listings: 4, column: 3, going: 2, live: 1 } as const;

export type TrendPull = {
  id: number;
  pulledAt: string;
  etDate: string;
  source: string;
  gameDate: string | null;
  opponent: string | null;
  median: number | null;
  getIn: number | null;
  liveAsk: number | null;
  compCount?: number | null;
  listingCount?: number | null;
  legacyLabel: string | null;
  /** Legacy backfill only. Never copied onto the public report. */
  payload: unknown;
};

export type TrendListing = {
  pullId: number;
  section: string | null;
  row: string | null;
  quantity: number | null;
  price: number | null;
  active: number | boolean | null;
};

export type TrendsGameSeed = {
  date: string;
  opponent: string;
  weekday: string;
  timeEt: string;
  type: string;
  demand: Demand | null;
  bookMedian: number | null;
  notes?: string;
  nationalTv?: boolean;
  /** Wizards win rate on the morning of the check, when we have one. */
  wizardsWinRate?: number | null;
  /** Book Sit / Sell / TBD. Missing means not flagged as keeping. */
  sitOrSell?: string;
  sold?: boolean;
  listedAsk?: number | null;
};

export type TrendPoint = {
  date: string;
  daysOut: number;
  median: number;
  cheapest: number | null;
};

export type TrendsGame = {
  date: string;
  opponent: string;
  weekday: string;
  timeEt: string;
  type: string;
  daysOut: number | null;
  checks: number;
  series: TrendPoint[];
  latestMedian: number | null;
  latestCheapest: number | null;
  /** Percent change versus the check on or before 7 days earlier. Null when that check is missing. */
  change7d: number | null;
  /** Percent change from the first median to the latest. */
  changeSinceFirst: number | null;
  /** Number to type today, per seat. */
  ask: number | null;
  keep: number | null;
  pair: number | null;
  projection: PriceProjection;
  /** Book choice. Sit means the seats stay out of the cash plan. */
  sitOrSell: string;
  sold: boolean;
  /** Cash already in from a sold pair. */
  banked: number;
  /** Candidate asks for the season cash plan. Empty when the game is sold or past. */
  offers: AskOffer[];
};

export type DaysOutBucket = {
  /** Midpoint of a 14-day bucket, in days before tip. */
  daysOut: number;
  /** Median of (that day's median / the game's first median). 1 means unchanged. */
  index: number;
  count: number;
};

export type TrendsReport = {
  today: string;
  section: string;
  row: string;
  seats: number[];
  band: string;
  firstCheck: string | null;
  lastCheck: string | null;
  gamesWithChecks: number;
  games: TrendsGame[];
  daysOutCurve: DaysOutBucket[];
  /** Plain-language note. No fit internals. */
  modelNote: string;
  early: boolean;
  /** Cash already in, expected cash still out, and the chance of clearing the goal. */
  outlook: SeasonOutlook;
};

type Kind = keyof typeof RANK;

type Observation = {
  gameDate: string;
  etDate: string;
  pulledAt: string;
  opponent: string | null;
  median: number;
  cheapest: number | null;
  /** Comparable seats that day, when the pull saved a count. */
  supply: number | null;
  kind: Kind;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function payloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function money(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

/** Drop a cheap number that is the arena floor, not a similar seat. */
export function plausibleCheapest(cheapest: number | null, median: number): number | null {
  if (cheapest == null || cheapest <= 0 || median <= 0) return null;
  if (cheapest > median) return null;
  if (cheapest < median * CHEAPEST_FLOOR) return null;
  return roundMoney(cheapest);
}

function isBandLabel(label: string): boolean {
  const text = label.toLowerCase();
  return (
    text.includes("jt_median") ||
    text.includes("j-t median") ||
    text.includes("107/108/118/119")
  );
}

/**
 * Middle and cheapest of the same similar-seat pool the book uses.
 * One lone cheapest Section 107 Row P seat is left out.
 */
export function bandQuote(
  listings: readonly CompListing[],
): { median: number; cheapest: number; count: number } | null {
  const serious = listings.filter((listing) => {
    if (!isCompListing(listing)) return false;
    return typeof listing.price === "number" && Number.isFinite(listing.price) && listing.price > 0;
  });
  if (serious.length === 0) return null;

  const floor = Math.min(...serious.map((listing) => Math.round((listing.price ?? 0) * 100)));
  const atFloor = serious.filter((listing) => Math.round((listing.price ?? 0) * 100) === floor);
  let pool = serious;
  const lone = atFloor[0];
  if (
    atFloor.length === 1 &&
    lone &&
    extractSectionNumber(lone.section) === "107" &&
    normalizeRow(lone.row) === "P"
  ) {
    pool = serious.filter((listing) => listing !== lone);
  }
  const prices = pool
    .map((listing) => listing.price)
    .filter((price): price is number => typeof price === "number" && price > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 1 ? prices[mid] : ((prices[mid - 1] ?? 0) + (prices[mid] ?? 0)) / 2;
  const cheapest = prices[0];
  if (median == null || cheapest == null) return null;
  return { median: roundMoney(median), cheapest: roundMoney(cheapest), count: prices.length };
}

function toComp(row: TrendListing): CompListing {
  return {
    active: row.active === true || row.active === 1,
    section: row.section ?? undefined,
    row: row.row ?? undefined,
    quantity: row.quantity ?? undefined,
    price: row.price ?? undefined,
  };
}

function fromLegacy(pull: TrendPull): Observation | null {
  if (!pull.gameDate || !DAY.test(pull.etDate)) return null;
  const label = pull.legacyLabel ?? "";
  if (!isBandLabel(label)) return null;
  const payload = payloadRecord(pull.payload);
  const going = money(payload?.going_price);
  const floor = money(payload?.["107p_floor"]);
  const live = money(pull.liveAsk) ?? money(payload?.live_107_ask);
  const getIn = money(pull.getIn) ?? money(payload?.get_in);
  const median = going ?? live;
  if (median == null) return null;
  return {
    gameDate: pull.gameDate,
    etDate: pull.etDate,
    pulledAt: pull.pulledAt,
    opponent: pull.opponent,
    median,
    cheapest: plausibleCheapest(floor ?? getIn, median),
    supply: supplyOf(pull),
    kind: going != null ? "going" : "live",
  };
}

function observePull(pull: TrendPull, listings: readonly CompListing[]): Observation | null {
  if (!pull.gameDate || !DAY.test(pull.gameDate) || !DAY.test(pull.etDate)) return null;
  const quote = listings.length > 0 ? bandQuote(listings) : null;
  if (quote) {
    return {
      gameDate: pull.gameDate,
      etDate: pull.etDate,
      pulledAt: pull.pulledAt,
      opponent: pull.opponent,
      median: quote.median,
      cheapest: quote.cheapest,
      supply: quote.count,
      kind: "listings",
    };
  }
  if (pull.source === "apify") return null;
  if (pull.source === "legacy-box") return fromLegacy(pull);
  const median = money(pull.median);
  if (median == null) return null;
  return {
    gameDate: pull.gameDate,
    etDate: pull.etDate,
    pulledAt: pull.pulledAt,
    opponent: pull.opponent,
    median,
    cheapest: plausibleCheapest(money(pull.getIn), median),
    supply: supplyOf(pull),
    kind: "column",
  };
}

function supplyOf(pull: TrendPull): number | null {
  const count = pull.compCount ?? pull.listingCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
  return Math.round(count);
}

/**
 * A repeated identical "live" median is a carried snapshot when the game also
 * has a real moving median. Keep the first time that dollar shows up.
 */
function dropCarriedLive(rows: readonly Observation[]): Observation[] {
  const byGame = new Map<string, Observation[]>();
  for (const row of rows) {
    const list = byGame.get(row.gameDate) ?? [];
    list.push(row);
    byGame.set(row.gameDate, list);
  }
  const kept: Observation[] = [];
  for (const list of byGame.values()) {
    const hasFresher = list.some((row) => row.kind !== "live");
    const seen = new Set<number>();
    const sorted = list
      .slice()
      .sort((a, b) => a.etDate.localeCompare(b.etDate) || a.pulledAt.localeCompare(b.pulledAt));
    for (const row of sorted) {
      if (row.kind === "live" && hasFresher) {
        const key = Math.round(row.median);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      kept.push(row);
    }
  }
  return kept;
}

function prefer(current: Observation, next: Observation): Observation {
  const currentRank = RANK[current.kind];
  const nextRank = RANK[next.kind];
  const winner =
    nextRank > currentRank
      ? next
      : currentRank > nextRank
        ? current
        : current.pulledAt <= next.pulledAt
          ? next
          : current;
  const other = winner === current ? next : current;
  const cheapest = winner.cheapest ?? other.cheapest;
  const supply = winner.supply ?? other.supply;
  if (cheapest === winner.cheapest && supply === winner.supply) return winner;
  return { ...winner, cheapest, supply };
}

function onePerDay(rows: readonly Observation[]): Map<string, Observation> {
  const days = new Map<string, Observation>();
  for (const row of rows) {
    const key = `${row.gameDate}|${row.etDate}`;
    const existing = days.get(key);
    days.set(key, existing ? prefer(existing, row) : row);
  }
  return days;
}

function percent(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

function addDays(ymd: string, days: number): string {
  const time = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

function change7d(series: readonly TrendPoint[]): number | null {
  const last = series[series.length - 1];
  if (!last) return null;
  const target = addDays(last.date, -7);
  let prior: TrendPoint | null = null;
  for (const point of series) {
    if (point.date <= target) prior = point;
  }
  if (!prior) return null;
  return percent(prior.median, last.median);
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left == null || right == null) return null;
  return (left + right) / 2;
}

function daysOutCurve(games: readonly TrendsGame[]): DaysOutBucket[] {
  const buckets = new Map<number, number[]>();
  for (const game of games) {
    const first = game.series[0]?.median;
    if (first == null || first <= 0) continue;
    for (const point of game.series) {
      if (point.daysOut < 0) continue;
      const start = Math.floor(point.daysOut / 14) * 14;
      const list = buckets.get(start) ?? [];
      list.push(point.median / first);
      buckets.set(start, list);
    }
  }
  const curve: DaysOutBucket[] = [];
  for (const [start, values] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (values.length < 3) continue;
    const index = medianOf(values);
    if (index == null) continue;
    curve.push({
      daysOut: start + 7,
      index: Math.round(index * 1000) / 1000,
      count: values.length,
    });
  }
  return curve;
}

function emptyProjection(sentence = NOT_ENOUGH_DATA): PriceProjection {
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

function marketRow(seed: TrendsGameSeed, point: { date: string; daysOut: number; median: number; supply: number | null }): MarketRow {
  return {
    gameDate: seed.date,
    snapshotDate: point.date,
    daysOut: point.daysOut,
    median: point.median,
    tier: opponentTier(seed.opponent, seed.demand),
    weekend: isWeekendGame(seed.weekday, seed.date),
    nationalTv: isNationalTv(seed.notes, seed.nationalTv),
    winRate: seed.wizardsWinRate ?? null,
    supply: point.supply,
  };
}

export function buildTrendsReport(input: {
  today: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly TrendPull[];
  listings: readonly TrendListing[];
  section?: string;
  row?: string;
  seats?: number[];
  breakEven?: number;
  cushion?: number;
  certainSales?: readonly ProbableSale[];
}): TrendsReport {
  return assembleTrends(input).report;
}

/** Same cleaned rows the trends page fits, so a saved cron fit matches the page. */
export function cleanedMarketRows(input: {
  today: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly TrendPull[];
  listings: readonly TrendListing[];
}): MarketRow[] {
  return assembleTrends(input).market;
}

export function cashGamesFor(
  games: readonly TrendsGame[],
  keeping: (game: TrendsGame) => boolean,
): CashGame[] {
  return games.map((game) => ({
    date: game.date,
    opponent: game.opponent,
    keeping: keeping(game),
    sold: game.sold,
    banked: game.banked,
    offers: game.offers,
  }));
}

/** Vanished comparable pairs. Possible sales, not sure ones. */
export function proxySales(pulls: readonly TrendPull[], listings: readonly TrendListing[]): ProbableSale[] {
  return detectLikelySales(compSnaps(pulls, listings));
}

export function outlookFor(
  games: readonly TrendsGame[],
  keeping: (game: TrendsGame) => boolean,
  options?: { breakEven?: number; cushion?: number },
): SeasonOutlook {
  return planSeason(cashGamesFor(games, keeping), options);
}

function assembleTrends(input: {
  today: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly TrendPull[];
  listings: readonly TrendListing[];
  section?: string;
  row?: string;
  seats?: number[];
  breakEven?: number;
  cushion?: number;
  certainSales?: readonly ProbableSale[];
}): { report: TrendsReport; market: MarketRow[] } {
  const listingsByPull = new Map<number, CompListing[]>();
  for (const row of input.listings) {
    const list = listingsByPull.get(row.pullId) ?? [];
    list.push(toComp(row));
    listingsByPull.set(row.pullId, list);
  }

  const observed: Observation[] = [];
  for (const pull of input.pulls) {
    const row = observePull(pull, listingsByPull.get(pull.id) ?? []);
    if (row) observed.push(row);
  }
  const daily = onePerDay(dropCarriedLive(observed));
  const byGame = new Map<string, Observation[]>();
  for (const row of daily.values()) {
    const list = byGame.get(row.gameDate) ?? [];
    list.push(row);
    byGame.set(row.gameDate, list);
  }

  const seeds = new Map<string, TrendsGameSeed>();
  for (const game of input.games) {
    if (DAY.test(game.date)) seeds.set(game.date, game);
  }
  for (const [gameDate, rows] of byGame) {
    if (seeds.has(gameDate)) continue;
    const opponent = rows.find((row) => row.opponent)?.opponent ?? "Home game";
    seeds.set(gameDate, {
      date: gameDate,
      opponent,
      weekday: "",
      timeEt: "",
      type: "",
      demand: null,
      bookMedian: null,
    });
  }

  const market: MarketRow[] = [];
  const latestSupply = new Map<string, number | null>();
  const games: TrendsGame[] = [];
  for (const seed of seeds.values()) {
    const rows = (byGame.get(seed.date) ?? [])
      .slice()
      .sort((a, b) => a.etDate.localeCompare(b.etDate) || a.pulledAt.localeCompare(b.pulledAt));
    const series: TrendPoint[] = [];
    for (const row of rows) {
      const pointDays = daysUntil(seed.date, row.etDate);
      if (pointDays == null) continue;
      series.push({
        date: row.etDate,
        daysOut: pointDays,
        median: roundMoney(row.median),
        cheapest: row.cheapest == null ? null : roundMoney(row.cheapest),
      });
      if (pointDays >= 0) {
        market.push(
          marketRow(seed, {
            date: row.etDate,
            daysOut: pointDays,
            median: row.median,
            supply: row.supply,
          }),
        );
        latestSupply.set(seed.date, row.supply);
      }
    }
    const daysOut = daysUntil(seed.date, input.today);
    const latest = series[series.length - 1] ?? null;
    const first = series[0] ?? null;
    let latestCheapest: number | null = null;
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const cheapest = series[index]?.cheapest;
      if (cheapest != null) {
        latestCheapest = cheapest;
        break;
      }
    }
    const basis = money(seed.bookMedian) ?? latest?.median ?? null;
    const ask =
      basis == null
        ? null
        : suggestFromMedian({
            listedMedian: basis,
            daysOut,
            demand: seed.demand,
          }).typeIn;

    games.push({
      date: seed.date,
      opponent: seed.opponent,
      weekday: seed.weekday,
      timeEt: seed.timeEt,
      type: seed.type,
      daysOut,
      checks: series.length,
      series,
      latestMedian: latest?.median ?? null,
      latestCheapest,
      change7d: change7d(series),
      changeSinceFirst: first && latest ? percent(first.median, latest.median) : null,
      ask,
      keep: ask == null ? null : keepFromTypeIn(ask),
      pair: ask == null ? null : pairFromTypeIn(ask),
      projection: daysOut == null ? emptyProjection() : emptyProjection(NOT_ENOUGH_DATA),
      sitOrSell: seed.sitOrSell ?? "",
      sold: seed.sold === true,
      banked: seed.sold && seed.listedAsk != null && seed.listedAsk > 0 ? pairFromTypeIn(seed.listedAsk) : 0,
      offers: [],
    });
  }

  const snaps = compSnaps(input.pulls, input.listings);
  const curve = calibrateSaleCurve(saleSamples(snaps, contextualSales(input.certainSales ?? [], snaps)));
  const fit = fitMarketModel(market, input.today);
  for (const game of games) {
    if (game.daysOut == null) continue;
    const seed = seeds.get(game.date);
    if (!seed) continue;
    game.projection = projectGame(fit, {
      gameDate: game.date,
      daysOut: game.daysOut,
      tier: opponentTier(seed.opponent, seed.demand),
      weekend: isWeekendGame(seed.weekday, seed.date),
      nationalTv: isNationalTv(seed.notes, seed.nationalTv),
      winRate: seed.wizardsWinRate ?? null,
      supply: latestSupply.get(game.date) ?? null,
      snapshots: game.checks,
      liveMedian: game.latestMedian,
    });
  }

  for (const game of games) {
    const fair = game.projection.todayPrice ?? game.latestMedian ?? money(seeds.get(game.date)?.bookMedian);
    const past = game.daysOut != null && game.daysOut < 0;
    game.offers =
      game.sold || past || fair == null
        ? []
        : askOffers({
            predictedMedian: fair,
            daysOut: Math.max(0, game.daysOut ?? 14),
            supply: latestSupply.get(game.date) ?? 6,
            curve,
          });
  }

  const planOptions = {
    breakEven: input.breakEven ?? SEASON_COST_DEFAULT,
    cushion: input.cushion ?? SEASON_CUSHION_DEFAULT,
  };
  const cash = cashGamesFor(games, (game) => game.sitOrSell === "Sit");
  const outlook = planSeason(cash, planOptions);
  for (const game of games) {
    if (game.sold) {
      game.projection = { ...game.projection, suggestion: soldSuggestion(game.banked) };
      continue;
    }
    if (game.sitOrSell === "Sit") {
      const flipped = planSeason(withKeeping(cash, game.date, false), planOptions);
      game.projection = { ...game.projection, suggestion: sitSuggestion(keepingSentence(outlook, flipped, true)) };
      continue;
    }
    const chosen = outlook.asks[game.date];
    if (!chosen) continue;
    game.projection = { ...game.projection, suggestion: suggestionFromOffer(chosen, outlook.lean) };
  }

  games.sort((a, b) => a.date.localeCompare(b.date) || a.opponent.localeCompare(b.opponent));

  let firstCheck: string | null = null;
  let lastCheck: string | null = null;
  let gamesWithChecks = 0;
  for (const game of games) {
    if (game.checks === 0) continue;
    gamesWithChecks += 1;
    const start = game.series[0]?.date ?? null;
    const end = game.series[game.series.length - 1]?.date ?? null;
    if (start && (firstCheck == null || start < firstCheck)) firstCheck = start;
    if (end && (lastCheck == null || end > lastCheck)) lastCheck = end;
  }

  return {
    report: {
      today: input.today,
      section: input.section ?? "107",
      row: input.row ?? "P",
      seats: input.seats ?? [1, 2],
      band: SIMILAR_SEATS,
      firstCheck,
      lastCheck,
      gamesWithChecks,
      games,
      daysOutCurve: daysOutCurve(games),
      modelNote: modelExplainer(),
      early: fit.ok ? fit.early : true,
      outlook,
    },
    market,
  };
}

function compSnaps(pulls: readonly TrendPull[], listings: readonly TrendListing[]): CompSnap[] {
  const pullById = new Map(pulls.map((pull) => [pull.id, pull]));
  const byPull = new Map<number, TrendListing[]>();
  for (const row of listings) {
    const list = byPull.get(row.pullId) ?? [];
    list.push(row);
    byPull.set(row.pullId, list);
  }
  const snaps: CompSnap[] = [];
  for (const [pullId, rows] of byPull) {
    const pull = pullById.get(pullId);
    if (!pull?.gameDate || !DAY.test(pull.etDate)) continue;
    const daysOut = daysUntil(pull.gameDate, pull.etDate);
    if (daysOut == null) continue;
    const comps = rows.map(toComp);
    const quote = bandQuote(comps);
    for (const row of rows) {
      const comp = toComp(row);
      if (!isCompListing(comp) || typeof comp.price !== "number" || comp.price <= 0) continue;
      snaps.push({
        gameDate: pull.gameDate,
        etDate: pull.etDate,
        pulledAt: pull.pulledAt,
        daysOut,
        section: extractSectionNumber(comp.section) ?? "",
        row: normalizeRow(comp.row) ?? "",
        quantity: comp.quantity ?? 0,
        price: comp.price,
        supply: quote?.count ?? null,
        median: quote?.median ?? null,
      });
    }
  }
  return snaps;
}

function contextualSales(sales: readonly ProbableSale[], snaps: readonly CompSnap[]): ProbableSale[] {
  const at = new Map<string, CompSnap>();
  for (const snap of snaps) {
    if (snap.median == null) continue;
    const key = `${snap.gameDate}|${snap.etDate}`;
    if (!at.has(key)) at.set(key, snap);
  }
  return sales.map((sale) => {
    if (sale.median != null && sale.median > 0) return sale;
    const snap = at.get(`${sale.gameDate}|${sale.goneDate}`) ?? at.get(`${sale.gameDate}|${sale.seenDate}`);
    if (!snap?.median) return sale;
    return { ...sale, median: snap.median, supply: sale.supply ?? snap.supply };
  });
}
