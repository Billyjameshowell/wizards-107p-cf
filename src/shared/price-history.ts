import { roundMoney } from "./book";
import { formatMoney } from "./format";
import { etDateFrom } from "./guardrails";

/**
 * Saved SeatData checks for one game. The suggestion uses a blend of those
 * checks, not only the latest snapshot.
 *
 * Recent checks count more (about half as much after a week). A morning with
 * many similar seats follows the live middle, but not the entire jump in one
 * day. A thin morning stays close to the recent middle. A steady step across
 * the last three busy checks leans a little further that way. Apify get-in and
 * arena median are not inputs here.
 */

/** Recent checks lose about half their weight each week. */
export const RECENCY_HALF_LIFE_DAYS = 7;
/** Pseudo-count. Four similar seats means the new morning is half the blend. */
export const SAMPLE_PRIOR_COUNT = 4;
export const THIN_COMP_COUNT = 3;
export const RICH_COMP_COUNT = 8;
/** Even a busy morning keeps a little of the recent middle. */
export const MAX_LIVE_TRUST = 0.92;
export const TREND_EXTRA_TRUST = 0.15;
export const TREND_MIN_COMPS = 4;
export const TREND_MIN_STEP = 0.02;
/** How long an empty morning can keep the last usable middle. */
export const MAX_PRIOR_HOLD_DAYS = 21;
/** Older checks fall out of the blend. */
export const OBSERVATION_WINDOW_DAYS = 45;
/** Rows older than this are deleted from D1. */
export const HISTORY_KEEP_DAYS = 120;
/** Tip inside this window is refreshed ahead of a far-out game. */
export const CLOSE_TIP_DAYS = 14;
export const CLOSE_BONUS_HOURS = 72;
export const SELL_BONUS_HOURS = 12;

export type CompConfidence = "thin" | "building" | "solid";

export type CompObservation = {
  pulledAt: string;
  /** America/New_York date of the check. A later check the same day replaces the earlier one. */
  etDate?: string;
  median: number | null;
  compCount: number;
  excludedDump?: boolean;
};

export type StoredPriceRow = {
  gameDate: string;
  source: string;
  etDate: string;
  pulledAt: string;
  median: number | null;
  compCount: number | null;
  excludedDump: boolean;
};

export type BlendResult = {
  median: number | null;
  pulls: number;
  confidence: CompConfidence;
  heldPrior: boolean;
  excludedDump: boolean;
  compCount: number;
};

export type CompGameOrder = {
  date: string;
  sit_or_sell: string;
  comp_checked_at?: string | null;
};

function finiteMedian(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function finiteCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

export function sampleTrust(compCount: number): number {
  const n = finiteCount(compCount);
  return n / (n + SAMPLE_PRIOR_COUNT);
}

export function recencyWeight(ageDays: number): number {
  return 0.5 ** (Math.max(0, ageDays) / RECENCY_HALF_LIFE_DAYS);
}

/** SeatData rows only. Arena prices stored beside them are ignored. */
export function compHistoryFromRows(rows: readonly StoredPriceRow[]): Map<string, CompObservation[]> {
  const map = new Map<string, CompObservation[]>();
  for (const row of rows) {
    if (row.source !== "seatdata") continue;
    const list = map.get(row.gameDate) ?? [];
    list.push({
      pulledAt: row.pulledAt,
      etDate: row.etDate,
      median: finiteMedian(row.median),
      compCount: finiteCount(row.compCount),
      excludedDump: row.excludedDump === true,
    });
    map.set(row.gameDate, list);
  }
  return map;
}

/** Today's check wins over an older row from the same ET day. */
export function mergeToday(
  existing: readonly CompObservation[],
  today: CompObservation,
): CompObservation[] {
  if (!today.etDate) return [...existing, today];
  const rest = existing.filter((obs) => obs.etDate !== today.etDate);
  const priorSame = existing.find((obs) => obs.etDate === today.etDate);
  if (!priorSame) return [...existing, today];
  const todayMs = Date.parse(today.pulledAt);
  const priorMs = Date.parse(priorSame.pulledAt);
  const winner =
    !Number.isNaN(todayMs) && (Number.isNaN(priorMs) || todayMs >= priorMs) ? today : priorSame;
  return [...rest, winner];
}

type Prepared = CompObservation & { at: number };

function prepare(observations: readonly CompObservation[], now: Date): Prepared[] {
  const indexed = observations.map((obs, index) => ({ obs, index }));
  indexed.sort((a, b) => {
    const delta = Date.parse(a.obs.pulledAt) - Date.parse(b.obs.pulledAt);
    if (!Number.isNaN(delta) && delta !== 0) return delta;
    return a.index - b.index;
  });

  const byDay = new Map<string, Prepared>();
  const loose: Prepared[] = [];
  for (const { obs } of indexed) {
    const at = Date.parse(obs.pulledAt);
    if (Number.isNaN(at)) continue;
    const ageDays = (now.getTime() - at) / 86_400_000;
    if (ageDays > OBSERVATION_WINDOW_DAYS || ageDays < -1) continue;
    const prepared: Prepared = {
      pulledAt: obs.pulledAt,
      etDate: obs.etDate,
      median: finiteMedian(obs.median),
      compCount: finiteCount(obs.compCount),
      excludedDump: obs.excludedDump === true,
      at,
    };
    if (obs.etDate) byDay.set(obs.etDate, prepared);
    else loose.push(prepared);
  }
  return [...byDay.values(), ...loose].sort((a, b) => a.at - b.at);
}

function weightedMedian(pulls: readonly Prepared[], nowMs: number): number | null {
  let weightSum = 0;
  let valueSum = 0;
  for (const pull of pulls) {
    if (pull.median == null) continue;
    const ageDays = (nowMs - pull.at) / 86_400_000;
    const weight = recencyWeight(ageDays) * Math.max(pull.compCount, 1);
    weightSum += weight;
    valueSum += weight * pull.median;
  }
  if (weightSum <= 0) return null;
  return valueSum / weightSum;
}

function trendBoost(usable: readonly Prepared[]): number {
  if (usable.length < 3) return 0;
  const last3 = usable.slice(-3);
  if (last3.some((pull) => pull.median == null || pull.compCount < TREND_MIN_COMPS)) return 0;
  const first = last3[0]?.median;
  const mid = last3[1]?.median;
  const last = last3[2]?.median;
  if (first == null || mid == null || last == null || first <= 0 || mid <= 0) return 0;
  const step1 = (mid - first) / first;
  const step2 = (last - mid) / mid;
  if (step1 > TREND_MIN_STEP && step2 > TREND_MIN_STEP) return TREND_EXTRA_TRUST;
  if (step1 < -TREND_MIN_STEP && step2 < -TREND_MIN_STEP) return TREND_EXTRA_TRUST;
  return 0;
}

function confidenceFor(latestCount: number, pulls: number, heldPrior: boolean): CompConfidence {
  if (pulls <= 0) return "thin";
  if (heldPrior) return pulls >= 3 ? "building" : "thin";
  if (latestCount < THIN_COMP_COUNT) return "thin";
  if (latestCount >= RICH_COMP_COUNT && pulls >= 3) return "solid";
  return "building";
}

function finish(args: {
  median: number | null;
  pulls: number;
  heldPrior: boolean;
  excludedDump: boolean;
  compCount: number;
}): BlendResult {
  return {
    median: args.median == null ? null : roundMoney(args.median),
    pulls: args.pulls,
    confidence: confidenceFor(args.compCount, args.pulls, args.heldPrior),
    heldPrior: args.heldPrior,
    excludedDump: args.excludedDump,
    compCount: args.compCount,
  };
}

export function blendCompHistory(
  observations: readonly CompObservation[],
  now: Date,
): BlendResult {
  const prepared = prepare(observations, now);
  const latest = prepared[prepared.length - 1];
  const usable = prepared.filter((pull) => pull.median != null);
  if (!latest || usable.length === 0) {
    return finish({
      median: null,
      pulls: 0,
      heldPrior: false,
      excludedDump: latest?.excludedDump === true,
      compCount: latest?.compCount ?? 0,
    });
  }

  if (latest.median == null) {
    const newest = usable[usable.length - 1];
    const ageDays = newest ? (now.getTime() - newest.at) / 86_400_000 : Infinity;
    if (!newest || ageDays > MAX_PRIOR_HOLD_DAYS) {
      return finish({
        median: null,
        pulls: 0,
        heldPrior: false,
        excludedDump: latest.excludedDump === true,
        compCount: 0,
      });
    }
    return finish({
      median: weightedMedian(usable, now.getTime()),
      pulls: usable.length,
      heldPrior: true,
      excludedDump: latest.excludedDump === true,
      compCount: 0,
    });
  }

  const prior = usable.slice(0, -1);
  if (prior.length === 0) {
    return finish({
      median: latest.median,
      pulls: 1,
      heldPrior: false,
      excludedDump: latest.excludedDump === true,
      compCount: latest.compCount,
    });
  }

  const priorMedian = weightedMedian(prior, now.getTime());
  if (priorMedian == null) {
    return finish({
      median: latest.median,
      pulls: usable.length,
      heldPrior: false,
      excludedDump: latest.excludedDump === true,
      compCount: latest.compCount,
    });
  }

  const trust = Math.min(MAX_LIVE_TRUST, sampleTrust(latest.compCount) + trendBoost(usable));
  return finish({
    median: trust * latest.median + (1 - trust) * priorMedian,
    pulls: usable.length,
    heldPrior: false,
    excludedDump: latest.excludedDump === true,
    compCount: latest.compCount,
  });
}

/** Quiet line under the suggestion. Hidden on the first check and when nothing new is listed. */
export function compHistoryNote(args: {
  pulls: number;
  confidence: CompConfidence | null;
  heldPrior: boolean;
  snapshotMedian: number | null;
  blendedMedian: number | null;
}): string | null {
  if (args.heldPrior || args.pulls < 2 || args.blendedMedian == null) return null;
  const snapshot = finiteMedian(args.snapshotMedian);
  const gap =
    snapshot == null
      ? false
      : Math.abs(snapshot - args.blendedMedian) >= Math.max(5, args.blendedMedian * 0.03);
  const today =
    gap && snapshot != null ? ` Today they are listed around ${formatMoney(snapshot)}.` : "";
  if (args.confidence === "thin") {
    return `Few similar seats are listed, so this stays close to recent prices.${today}`;
  }
  if (args.confidence === "solid") {
    return `A lot of similar seats are listed, so this follows the recent market.${today}`;
  }
  return `This uses today's listings and recent prices for these seats.${today}`;
}

function daysUntilTip(gameDate: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const game = Date.parse(`${gameDate}T00:00:00Z`);
  const start = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(game) || Number.isNaN(start)) return null;
  return Math.round((game - start) / 86_400_000);
}

function urgency(game: CompGameOrder, now: Date, today: string): number {
  const checked = game.comp_checked_at ? Date.parse(game.comp_checked_at) : Number.NaN;
  if (!game.comp_checked_at || Number.isNaN(checked)) return Number.POSITIVE_INFINITY;
  let hours = (now.getTime() - checked) / 3_600_000;
  const daysOut = daysUntilTip(game.date, today);
  if (daysOut != null && daysOut >= 0 && daysOut <= CLOSE_TIP_DAYS) hours += CLOSE_BONUS_HOURS;
  if (game.sit_or_sell === "Sell") hours += SELL_BONUS_HOURS;
  return hours;
}

/**
 * Same pull budget, spread across the book. A game we have never checked
 * (including one whose event just appeared) goes first. After that, a game
 * close to tip is refreshed ahead of a far-out game, unless the far-out game
 * has gone much longer without a look. Sell games win ties.
 */
export function orderGamesForCompPull<T extends CompGameOrder>(games: readonly T[], now: Date): T[] {
  const today = etDateFrom(now);
  return [...games].sort((a, b) => {
    const aUrgency = urgency(a, now, today);
    const bUrgency = urgency(b, now, today);
    if (aUrgency !== bUrgency) return bUrgency - aUrgency;
    const sell = Number(b.sit_or_sell === "Sell") - Number(a.sit_or_sell === "Sell");
    if (sell !== 0) return sell;
    return a.date.localeCompare(b.date);
  });
}
