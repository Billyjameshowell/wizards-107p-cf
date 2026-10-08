/**
 * Placeholder tip-off sketch.
 *
 * Swap this body for the real model later (a hierarchical fit of log price
 * on a days-out curve, plus game features). Keep these types stable:
 *
 * - Input: one game's comparable-seat series, and that game's features.
 * - Output: a per-seat price at tip with a low/high range, or not enough data.
 *
 * This sketch only extends the recent pace. It is not a forecast to trust.
 * A game needs at least three median checks spanning a week, and the pace
 * out to tip has to stay within half of the latest price. Otherwise it says
 * there is not enough data yet.
 */

export const NOT_ENOUGH_DATA = "Not enough data yet.";

/** Median checks required before a game-day number is shown. */
export const MIN_POINTS = 3;
/** The checks have to cover at least this many days. */
export const MIN_SPAN_DAYS = 7;
/**
 * If carrying the recent pace to tip would move the price by more than this
 * share of the latest median, the sketch refuses instead of guessing.
 */
export const MAX_PACE_MOVE = 0.5;

export type PriceObservation = {
  /** America/New_York date of the check, YYYY-MM-DD. */
  date: string;
  /** Days from this check until tip. Negative means the check is after tip. */
  daysOut: number;
  /** Middle of similar seats that day, per seat. */
  median: number;
  /** Cheapest similar seat that day, when one was saved. */
  cheapest: number | null;
};

export type GameFeatures = {
  date: string;
  opponent: string;
  /** "preseason", "regular", or whatever the book stored. */
  type: string;
  weekday: string;
  /** Days from today until tip. Negative means the game has tipped. */
  daysOut: number;
};

export type PriceProjection = {
  enough: boolean;
  /** Whole-dollar per-seat price at tip. Null when enough is false. */
  price: number | null;
  low: number | null;
  high: number | null;
  /** One plain sentence. NOT_ENOUGH_DATA when the series is too thin. */
  sentence: string;
};

function notEnough(sentence = NOT_ENOUGH_DATA): PriceProjection {
  return { enough: false, price: null, low: null, high: null, sentence };
}

function daysBetween(earlier: string, later: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(earlier) || !/^\d{4}-\d{2}-\d{2}$/.test(later)) return null;
  const start = Date.parse(`${earlier}T00:00:00Z`);
  const end = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function windowPhrase(days: number): string {
  const weeks = Math.round(days / 7);
  if (days >= 13 && weeks >= 2) return `${weeks} weeks`;
  if (days === 1) return "1 day";
  return `${days} days`;
}

function paceAnchor(points: readonly PriceObservation[], last: PriceObservation): PriceObservation | null {
  let best: PriceObservation | null = null;
  let bestGap = 0;
  let bestDist = Infinity;
  for (const point of points) {
    if (point.date >= last.date) continue;
    const gap = daysBetween(point.date, last.date);
    if (gap == null || gap < MIN_SPAN_DAYS) continue;
    const dist = Math.abs(gap - 14);
    if (dist < bestDist || (dist === bestDist && gap > bestGap)) {
      best = point;
      bestGap = gap;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Rough per-seat price at tip from this game's own recent pace.
 * Game features other than days-out are accepted and ignored here so a
 * later model can use opponent, weekday, and game type without a new call.
 */
export function projectTipPrice(
  series: readonly PriceObservation[],
  game: GameFeatures,
): PriceProjection {
  if (game.daysOut < 0) return notEnough("This game has already tipped.");

  const byDate = new Map<string, PriceObservation>();
  for (const point of series) {
    if (!Number.isFinite(point.median) || point.median <= 0) continue;
    if (!Number.isFinite(point.daysOut)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    byDate.set(point.date, point);
  }
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last = points[points.length - 1];
  const first = points[0];
  if (!last || !first || points.length < MIN_POINTS) return notEnough();
  const span = daysBetween(first.date, last.date);
  if (span == null || span < MIN_SPAN_DAYS) return notEnough();

  const anchor = paceAnchor(points, last);
  if (!anchor || anchor.median <= 0) return notEnough();
  const gap = daysBetween(anchor.date, last.date);
  if (gap == null || gap < MIN_SPAN_DAYS) return notEnough();

  const change = (last.median - anchor.median) / anchor.median;
  const weeks = gap / 7;
  const weeksLeft = Math.max(0, game.daysOut) / 7;
  const projected = last.median * (1 + change * (weeksLeft / weeks));
  if (!Number.isFinite(projected) || projected < 1) return notEnough();
  const move = Math.abs(projected - last.median) / last.median;
  if (move > MAX_PACE_MOVE) return notEnough();

  const price = Math.round(projected);
  let low = Math.round(Math.min(last.median, projected) * 0.9);
  let high = Math.round(Math.max(last.median, projected) * 1.1);
  if (low < 1) low = 1;
  if (low > price) low = price;
  if (high < price) high = price;

  const percent = Math.round(Math.abs(change) * 100);
  const window = windowPhrase(gap);
  let sentence: string;
  if (percent === 0) {
    sentence = `Prices for this game have held steady over ${window}. At this pace they'd be around ${dollars(price)} by game day.`;
  } else {
    const direction = change < 0 ? "dropped" : "risen";
    sentence = `Prices for this game have ${direction} ${percent}% in ${window}; at this pace they'd be around ${dollars(price)} by game day.`;
  }

  return { enough: true, price, low, high, sentence };
}
