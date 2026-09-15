import { formatEtStamp, recomputeBookTotals, type Book, type Game } from "../src/shared/book";
import { etDateFrom, openCircuit, parseFlags, type Flags } from "../src/shared/guardrails";
import { runApify } from "./adapters/apify";
import { runSeatData } from "./adapters/seatdata";
import type { AdapterResult, MarketPoint } from "./adapters/types";
import {
  loadLiveBook,
  readSpend,
  writeBookAndHistory,
  writeSpend,
  type PriceHistorySnapshot,
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

function pointHasMetrics(point: MarketPoint): boolean {
  return Object.keys(point).some((key) => key !== "date");
}

function applyPoints(
  game: Game,
  points: MarketPoint[],
  source: AdapterResult["source"],
  now: Date,
): Game {
  const next = { ...game };
  for (const point of points) {
    if (point.date !== game.date) continue;
    if (pointHasMetrics(point)) {
      next.market_updated_at_et = formatEtStamp(now);
    }
    if (point.advisedAsk != null) next.advised_ask = point.advisedAsk;
    if (point.getIn != null) next.market_get_in = point.getIn;
    if (point.median != null) next.market_median = point.median;
    if (point.listingCount != null) next.listing_count = point.listingCount;
    if (source === "seatdata" && point.marketDetails != null) {
      // A comparison is meaningful only when both observations came from
      // SeatData. Preserve the prior current snapshot before replacing it.
      next.market_previous_details = next.market_details?.source === "seatdata"
        ? next.market_details
        : null;
      next.market_details = point.marketDetails;
    }
    if (next.advised_ask == null && point.getIn != null) {
      next.advised_ask = point.getIn;
    }
  }
  return next;
}

function mergeBook(book: Book, results: AdapterResult[], now: Date): Book {
  const bySourceDate = new Map<AdapterResult["source"], Map<string, MarketPoint[]>>();
  for (const result of results) {
    for (const point of result.points) {
      const byDate = bySourceDate.get(result.source) ?? new Map<string, MarketPoint[]>();
      // A provider should emit one point per game, but keeping the last point
      // makes duplicate rows in one run unable to masquerade as history from
      // a prior run when selecting the book's previous snapshot.
      byDate.set(point.date, [point]);
      bySourceDate.set(result.source, byDate);
    }
  }
  const games = book.games.map((game) => {
    let next = game;
    for (const result of results) {
      const points = bySourceDate.get(result.source)?.get(game.date) ?? [];
      next = applyPoints(next, points, result.source, now);
    }
    return next;
  });
  return recomputeBookTotals({
    ...book,
    games,
    asof_et: formatEtStamp(now),
    list_nothing_until_billy_says: true,
  });
}

function historyFromResults(
  book: Book,
  results: AdapterResult[],
  capturedAt: string,
): PriceHistorySnapshot[] {
  const gameDates = new Set(book.games.map((game) => game.date));
  const unique = new Map<string, PriceHistorySnapshot>();
  for (const result of results) {
    for (const point of result.points) {
      // Adapter points represent completed provider observations. A date-only
      // object is not an observation and must not create a false refresh.
      if (!gameDates.has(point.date) || !pointHasMetrics(point)) continue;
      const snapshot: PriceHistorySnapshot = {
        gameDate: point.date,
        source: result.source,
        capturedAt,
        advisedAsk: point.advisedAsk ?? null,
        getIn: point.marketDetails != null ? point.marketDetails.get_in : point.getIn ?? null,
        median: point.marketDetails != null ? point.marketDetails.median : point.median ?? null,
        listingCount: point.listingCount ?? null,
        lastSale: point.lastSale ?? null,
        marketDetails: point.marketDetails ?? null,
      };
      unique.set(`${snapshot.gameDate}\u0000${snapshot.source}\u0000${snapshot.capturedAt}`, snapshot);
    }
  }
  return [...unique.values()];
}

function flagsFromEnv(env: Env): Flags {
  return parseFlags(env);
}

async function runIngestUnlocked(
  env: Env,
  trigger: IngestTrigger,
  now = new Date(),
  seed = false,
): Promise<IngestSummary> {
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

  if (seed) {
    const claimed = await env.DB.prepare(
      "INSERT INTO store (key, value, updated_at) VALUES ('seed_20260915', ?, ?) ON CONFLICT(key) DO NOTHING",
    ).bind(JSON.stringify({ status: "started", at: now.toISOString() }), now.toISOString()).run();
    if (!claimed.meta.changes) {
      return { trigger, ingestEnabled: true, dryRun: false, skippedReason: "seed_already_claimed",
        bookUpdated: false, asof_et: book.asof_et, sources: [] };
    }
  }

  const ctx = { env, games: book.games, now, seed };

  if (flags.sources.includes("seatdata")) {
    try {
      const seat = await runSeatData(ctx, spend, etDate);
      spend = seat.spend;
      sources.push(seat.result);
    } catch {
      spend = await readSpend(env, now);
      spend.sources.seatdata = openCircuit(spend.sources.seatdata, etDate, "request_failed");
      await writeSpend(env, spend);
      sources.push({ source: "seatdata", paid: true, aborted: "request_failed", points: [] });
    }
  }

  if (flags.sources.includes("apify")) {
    try {
      const apify = await runApify(ctx, spend, etDate);
      spend = apify.spend;
      sources.push(apify.result);
    } catch {
      spend = await readSpend(env, now);
      spend.sources.apify = openCircuit(spend.sources.apify, etDate, "request_failed");
      await writeSpend(env, spend);
      sources.push({ source: "apify", paid: true, aborted: "request_failed", points: [] });
    }
  }

  const snapshots = historyFromResults(book, sources, now.toISOString());
  const hasPoints = snapshots.length > 0;
  let nextBook = book;
  if (hasPoints) {
    nextBook = mergeBook(book, sources, now);
    await writeBookAndHistory(env, nextBook, snapshots);
  }

  spend.lastRun = {
    at: now.toISOString(),
    trigger,
    ingestEnabled: true,
    dryRun: false,
    bookUpdated: hasPoints,
    seed,
    sources: Object.fromEntries(
      sources.map((result) => [
        result.source,
        {
          attempted: result.aborted !== "missing_credential" && result.aborted !== "source_off",
          paid: result.paid,
          aborted: result.aborted,
          pulls: result.pulls,
          spend: result.spend,
        },
      ]),
    ),
  };
  await writeSpend(env, spend);
  if (seed) {
    await env.DB.prepare("UPDATE store SET value = ?, updated_at = ? WHERE key = 'seed_20260915'")
      .bind(JSON.stringify({ status: nextBook.games.every(g => g.advised_ask != null) ? "finished" : "partial", at: now.toISOString(),
        pricedGames: nextBook.games.filter(g => g.advised_ask != null).length,
        totalGames: nextBook.games.length,
        sources: spend.lastRun.sources }), new Date().toISOString()).run();
  }

  return {
    trigger,
    ingestEnabled: true,
    dryRun: false,
    bookUpdated: hasPoints,
    asof_et: nextBook.asof_et,
    sources,
  };
}

/**
 * Serialize scheduled and manual runs so concurrent requests cannot bypass caps.
 * A seed can spend over 10 minutes in bounded provider timeouts; its lease must
 * cover that path as well as the normal smaller ingest.
 */
export async function runIngest(env: Env, trigger: IngestTrigger, now = new Date(), seed = false): Promise<IngestSummary> {
  const token = crypto.randomUUID();
  const acquired = await env.DB.prepare(
    `INSERT INTO store (key, value, updated_at) VALUES ('ingest_lock', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE store.updated_at < ?`,
  ).bind(token, new Date(now.getTime() + 30 * 60_000).toISOString(), now.toISOString()).run();
  if (!acquired.meta.changes) {
    const book = await loadLiveBook(env);
    const flags = flagsFromEnv(env);
    return { trigger, ingestEnabled: flags.ingestEnabled, dryRun: flags.dryRun,
      skippedReason: "run_in_progress", bookUpdated: false, asof_et: book.asof_et, sources: [] };
  }
  try {
    return await runIngestUnlocked(env, trigger, now, seed && trigger === "http");
  } finally {
    await env.DB.prepare("DELETE FROM store WHERE key = 'ingest_lock' AND value = ?").bind(token).run();
  }
}
