import type { ObservedPull } from "../src/shared/archive";
import { formatEtStamp, recomputeBookTotals, type Book, type Game } from "../src/shared/book";
import { etDateFrom, parseFlags, type Flags, type SpendState } from "../src/shared/guardrails";
import {
  blendCompHistory,
  mergeToday,
  type CompObservation,
} from "../src/shared/price-history";
import { runApify } from "./adapters/apify";
import { runSeatData } from "./adapters/seatdata";
import type { AdapterResult, MarketPoint } from "./adapters/types";
import { archiveObserved, ensureArchiveBackfill, rowsForAdapter } from "./archive-store";
import {
  loadLiveBook,
  readCompHistory,
  readSpend,
  recordPriceHistory,
  writeBook,
  writeSpend,
  type PriceHistoryWrite,
} from "./store";

export type IngestTrigger = "cron" | "http";

export type IngestSummary = {
  trigger: IngestTrigger;
  ingestEnabled: boolean;
  dryRun: boolean;
  skippedReason?: string;
  bookUpdated: boolean;
  asof_et: string;
  sources: AdapterResult[];
};

function isCompPoint(point: MarketPoint): boolean {
  return (
    point.compMedian !== undefined ||
    point.compCount !== undefined ||
    point.compExcludedDump !== undefined
  );
}

function positive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function todayObservation(point: MarketPoint, now: Date, etDate: string): CompObservation {
  const median = positive(point.compMedian);
  const compCount =
    median != null && typeof point.compCount === "number" && point.compCount > 0
      ? Math.round(point.compCount)
      : 0;
  return {
    pulledAt: now.toISOString(),
    etDate,
    median,
    compCount,
    excludedDump: point.compExcludedDump === true,
  };
}

function historyWrites(results: AdapterResult[], etDate: string, now: Date): PriceHistoryWrite[] {
  const pulledAt = now.toISOString();
  const byKey = new Map<string, PriceHistoryWrite>();
  for (const result of results) {
    for (const point of result.points) {
      const row: PriceHistoryWrite | null =
        result.source === "seatdata" && isCompPoint(point)
          ? {
              gameDate: point.date,
              source: "seatdata",
              etDate,
              pulledAt,
              median: positive(point.compMedian),
              getIn: null,
              listingCount: null,
              compCount:
                positive(point.compMedian) != null && typeof point.compCount === "number"
                  ? Math.max(0, Math.round(point.compCount))
                  : 0,
              excludedDump: point.compExcludedDump === true,
            }
          : result.source === "apify"
            ? {
                gameDate: point.date,
                source: "apify",
                etDate,
                pulledAt,
                median: positive(point.median),
                getIn: positive(point.getIn),
                listingCount:
                  typeof point.listingCount === "number" && point.listingCount >= 0
                    ? Math.round(point.listingCount)
                    : null,
                compCount: null,
                excludedDump: false,
              }
            : null;
      if (!row) continue;
      byKey.set(`${row.gameDate}|${row.source}|${row.etDate}`, row);
    }
  }
  return [...byKey.values()];
}

/**
 * A typed price lives in the browser. This never writes one.
 * SeatData updates the band middle. Apify may update the arena get-in and
 * median, which the suggestion does not use.
 */
function applyPoints(
  game: Game,
  points: MarketPoint[],
  history: ReadonlyMap<string, CompObservation[]>,
  now: Date,
  etDate: string,
): Game {
  const next = { ...game };
  let compPoint: MarketPoint | undefined;
  for (const point of points) {
    if (point.date !== game.date) continue;
    if (point.advisedAsk != null) next.advised_ask = point.advisedAsk;
    if (point.getIn != null) next.market_get_in = point.getIn;
    if (point.median != null) next.market_median = point.median;
    if (point.listingCount != null) next.listing_count = point.listingCount;
    if (isCompPoint(point)) compPoint = point;
  }
  if (!compPoint) return next;

  const today = todayObservation(compPoint, now, etDate);
  const priorRows = history.get(game.date) ?? [];
  const blend = blendCompHistory(mergeToday(priorRows, today), now);
  const keepStored =
    blend.median == null &&
    priorRows.length === 0 &&
    typeof game.comp_median === "number" &&
    game.comp_median > 0;

  next.comp_snapshot_median = today.median;
  next.comp_count = today.compCount;
  next.comp_excluded_dump = today.excludedDump;
  next.comp_checked_at = now.toISOString();
  if (keepStored) {
    next.comp_median = game.comp_median;
    next.comp_held_prior = true;
    next.comp_pulls = game.comp_pulls ?? 1;
    next.comp_confidence = game.comp_confidence ?? "thin";
  } else {
    next.comp_median = blend.median;
    next.comp_held_prior = blend.heldPrior;
    next.comp_pulls = blend.pulls;
    next.comp_confidence = blend.confidence;
  }
  return next;
}

export function mergeBook(
  book: Book,
  results: AdapterResult[],
  now: Date,
  history: ReadonlyMap<string, CompObservation[]> = new Map(),
): Book {
  const etDate = etDateFrom(now);
  const byDate = new Map<string, MarketPoint[]>();
  for (const result of results) {
    for (const point of result.points) {
      const list = byDate.get(point.date) ?? [];
      list.push(point);
      byDate.set(point.date, list);
    }
  }
  const games = book.games.map((game) =>
    applyPoints(game, byDate.get(game.date) ?? [], history, now, etDate),
  );
  return recomputeBookTotals({
    ...book,
    games,
    asof_et: formatEtStamp(now),
    list_nothing_until_billy_says: true,
  });
}

function flagsFromEnv(env: Env): Flags {
  return parseFlags(env);
}

async function saveArchive(
  env: Env,
  trigger: IngestTrigger,
  now: Date,
  batches: { source: string; rows: ObservedPull[] }[],
): Promise<void> {
  for (const batch of batches) {
    if (batch.rows.length === 0) continue;
    await archiveObserved(env, { trigger, now, source: batch.source, rows: batch.rows });
  }
}

export async function runIngest(
  env: Env,
  trigger: IngestTrigger,
  now = new Date(),
): Promise<IngestSummary> {
  try {
    await ensureArchiveBackfill(env);
  } catch (error) {
    console.error("price archive backfill", error);
  }
  const flags = flagsFromEnv(env);
  const etDate = etDateFrom(now);
  const book = await loadLiveBook(env);
  let spend = await readSpend(env, now);
  const sources: AdapterResult[] = [];

  if (!flags.ingestEnabled) {
    spend.lastRun = {
      at: now.toISOString(),
      trigger,
      ingestEnabled: false,
      dryRun: flags.dryRun,
      skippedReason: "ingest_disabled",
      sources: {},
    };
    await writeSpend(env, spend);
    return {
      trigger,
      ingestEnabled: false,
      dryRun: flags.dryRun,
      skippedReason: "ingest_disabled",
      bookUpdated: false,
      asof_et: book.asof_et,
      sources,
    };
  }

  if (flags.dryRun) {
    spend.lastRun = {
      at: now.toISOString(),
      trigger,
      ingestEnabled: true,
      dryRun: true,
      skippedReason: "dry_run",
      sources: Object.fromEntries(
        flags.sources.map((source) => [
          source,
          { attempted: false, paid: false, aborted: "dry_run" },
        ]),
      ),
    };
    await writeSpend(env, spend);
    return {
      trigger,
      ingestEnabled: true,
      dryRun: true,
      skippedReason: "dry_run",
      bookUpdated: false,
      asof_et: book.asof_et,
      sources: flags.sources.map((source) => ({
        source,
        paid: false,
        aborted: "dry_run",
        points: [],
      })),
    };
  }

  const ctx = {
    env,
    games: book.games,
    now,
    saveSpend: (next: SpendState) => writeSpend(env, next),
  };
  const archives: { source: string; rows: ObservedPull[] }[] = [];

  if (flags.sources.includes("seatdata")) {
    const seat = await runSeatData(ctx, spend, etDate);
    spend = seat.spend;
    sources.push(seat.result);
    archives.push({
      source: "seatdata",
      rows: rowsForAdapter({
        aborted: seat.result.aborted,
        paid: seat.result.paid,
        points: seat.result.points,
        observations: seat.observations,
      }),
    });
  }

  if (flags.sources.includes("apify")) {
    const apify = await runApify(ctx, spend, etDate);
    spend = apify.spend;
    sources.push(apify.result);
    archives.push({
      source: "apify",
      rows: rowsForAdapter({
        aborted: apify.result.aborted,
        paid: apify.result.paid,
        points: apify.result.points,
        observations: apify.observations,
      }),
    });
  }

  try {
    await saveArchive(env, trigger, now, archives);
  } catch (error) {
    console.error("price archive", error);
  }

  const hasPoints = sources.some((result) => result.points.length > 0);
  let nextBook = book;
  if (hasPoints) {
    let history = new Map<string, CompObservation[]>();
    try {
      await recordPriceHistory(env, historyWrites(sources, etDate, now), now);
    } catch (error) {
      console.error("price history write", error);
    }
    try {
      history = await readCompHistory(env);
    } catch (error) {
      console.error("price history read", error);
    }
    nextBook = mergeBook(book, sources, now, history);
    await writeBook(env, nextBook);
  }

  spend.lastRun = {
    at: now.toISOString(),
    trigger,
    ingestEnabled: true,
    dryRun: false,
    sources: Object.fromEntries(
      sources.map((result) => [
        result.source,
        {
          attempted: true,
          paid: result.paid,
          aborted: result.aborted,
          pulls: result.pulls,
        },
      ]),
    ),
  };
  await writeSpend(env, spend);

  return {
    trigger,
    ingestEnabled: true,
    dryRun: false,
    bookUpdated: hasPoints,
    asof_et: nextBook.asof_et,
    sources,
  };
}
