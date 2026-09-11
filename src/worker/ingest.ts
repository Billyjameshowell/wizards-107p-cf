import { formatEtStamp, recomputeBookTotals, type Book, type Game } from "@shared/book";
import { etDateFrom, parseFlags, type Flags } from "@shared/guardrails";
import { runApify } from "./adapters/apify";
import { runSeatData } from "./adapters/seatdata";
import type { AdapterResult, MarketPoint } from "./adapters/types";
import { loadLiveBook, writeBook, readSpend, writeSpend } from "./store";

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

function applyPoints(game: Game, points: MarketPoint[]): Game {
  const next = { ...game };
  for (const point of points) {
    if (point.date !== game.date) continue;
    if (point.advisedAsk != null) next.advised_ask = point.advisedAsk;
    if (point.getIn != null) next.market_get_in = point.getIn;
    if (point.median != null) next.market_median = point.median;
    if (point.listingCount != null) next.listing_count = point.listingCount;
    if (next.advised_ask == null && point.getIn != null) {
      next.advised_ask = point.getIn;
    }
  }
  return next;
}

function mergeBook(book: Book, results: AdapterResult[], now: Date): Book {
  const byDate = new Map<string, MarketPoint[]>();
  for (const result of results) {
    for (const point of result.points) {
      const list = byDate.get(point.date) ?? [];
      list.push(point);
      byDate.set(point.date, list);
    }
  }
  const games = book.games.map((game) => applyPoints(game, byDate.get(game.date) ?? []));
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

export async function runIngest(
  env: Env,
  trigger: IngestTrigger,
  now = new Date(),
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
        flags.sources.map((source) => [source, { attempted: false, paid: false, aborted: "dry_run" }]),
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

  const ctx = { env, games: book.games, now };

  if (flags.sources.includes("seatdata")) {
    const seat = await runSeatData(ctx, spend, etDate);
    spend = seat.spend;
    sources.push(seat.result);
  }

  if (flags.sources.includes("apify")) {
    const apify = await runApify(ctx, spend, etDate);
    spend = apify.spend;
    sources.push(apify.result);
  }

  const hasPoints = sources.some((result) => result.points.length > 0);
  let nextBook = book;
  if (hasPoints) {
    nextBook = mergeBook(book, sources, now);
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
