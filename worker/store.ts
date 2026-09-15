import type { Book, MarketDetails } from "../src/shared/book";
import {
  emptySpendState,
  etDateFrom,
  rolloverSpend,
  type SpendState,
} from "../src/shared/guardrails";
import seedBook from "../data/seed-book.json" with { type: "json" };

const BOOK_KEY = "book";
const SPEND_KEY = "spend";

export type PriceHistorySource = "seatdata" | "apify";

/** One successful provider observation for one game in one ingest run. */
export type PriceHistorySnapshot = {
  gameDate: string;
  source: PriceHistorySource;
  capturedAt: string;
  advisedAsk: number | null;
  getIn: number | null;
  median: number | null;
  listingCount: number | null;
  lastSale: number | null;
  marketDetails: MarketDetails | null;
};

export const SEED_BOOK = seedBook as Book;

async function ensureTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
}

async function ensureHistoryTable(env: Env): Promise<void> {
  // The migration creates this table in deployed environments. Keeping this
  // idempotent makes first-use local databases and test D1s self-healing.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS price_history (
      game_date TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('seatdata', 'apify')),
      captured_at TEXT NOT NULL,
      advised_ask REAL,
      get_in REAL,
      median REAL,
      listing_count INTEGER,
      last_sale REAL,
      market_details TEXT,
      PRIMARY KEY (game_date, source, captured_at)
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_price_history_game_source_captured
       ON price_history (game_date, source, captured_at DESC)`,
  ).run();
}

async function readStore(env: Env, key: string): Promise<string | null> {
  try {
    await ensureTable(env);
    const row = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    // D1 is the durable source of truth. Only use KV as a compatibility
    // fallback when D1 is unavailable or has not been initialized yet.
    if (row?.value) return row.value;
  } catch {
    // KV may be unbound in a broken local setup; fall through to D1's mirror.
  }
  try {
    return (await env.BOOK.get(key)) ?? null;
  } catch {
    return null;
  }
}

async function readDurableStore(env: Env, key: string): Promise<string | null> {
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeStore(env: Env, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await ensureTable(env);
  await env.DB.prepare(
    `INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();
  try {
    await env.BOOK.put(key, value);
  } catch {
    // D1 is the durable source of truth if KV write fails.
  }
}

export async function readBook(env: Env): Promise<Book | null> {
  const raw = await readStore(env, BOOK_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Book;
  } catch {
    return null;
  }
}

export async function readDurableBook(env: Env): Promise<Book | null> {
  const raw = await readDurableStore(env, BOOK_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as Book;
}

export async function writeBook(
  env: Env,
  book: Book,
  snapshots: readonly PriceHistorySnapshot[] = [],
): Promise<void> {
  await writeBookAndHistory(env, book, snapshots);
}

/**
 * Atomically persist the live book and the successful observations that
 * produced it. KV is updated only after the D1 batch has committed.
 */
export async function writeBookAndHistory(
  env: Env,
  book: Book,
  snapshots: readonly PriceHistorySnapshot[],
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const bookValue = JSON.stringify(book);
  await ensureTable(env);
  await ensureHistoryTable(env);

  const statements = [
    env.DB.prepare(
      `INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(BOOK_KEY, bookValue, updatedAt),
    ...snapshots.map((snapshot) => env.DB.prepare(
      `INSERT INTO price_history
       (game_date, source, captured_at, advised_ask, get_in, median,
        listing_count, last_sale, market_details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_date, source, captured_at) DO NOTHING`,
    ).bind(
      snapshot.gameDate,
      snapshot.source,
      snapshot.capturedAt,
      snapshot.advisedAsk,
      snapshot.getIn,
      snapshot.median,
      snapshot.listingCount,
      snapshot.lastSale,
      snapshot.marketDetails == null ? null : JSON.stringify(snapshot.marketDetails),
    )),
  ];
  await env.DB.batch(statements);

  try {
    await env.BOOK.put(BOOK_KEY, bookValue);
  } catch {
    // D1 is durable even when the eventually consistent KV mirror is down.
  }
}

/** Read history for diagnostics and tests; rows are returned oldest first. */
export async function readPriceHistory(
  env: Env,
  gameDate: string,
  source?: PriceHistorySource,
): Promise<PriceHistorySnapshot[]> {
  await ensureHistoryTable(env);
  const query = source
    ? "SELECT * FROM price_history WHERE game_date = ? AND source = ? ORDER BY captured_at ASC"
    : "SELECT * FROM price_history WHERE game_date = ? ORDER BY captured_at ASC";
  const statement = source
    ? env.DB.prepare(query).bind(gameDate, source)
    : env.DB.prepare(query).bind(gameDate);
  const result = await statement.all<{
    game_date: string;
    source: PriceHistorySource;
    captured_at: string;
    advised_ask: number | null;
    get_in: number | null;
    median: number | null;
    listing_count: number | null;
    last_sale: number | null;
    market_details: string | null;
  }>();
  return (result.results ?? []).map((row) => ({
    gameDate: row.game_date,
    source: row.source,
    capturedAt: row.captured_at,
    advisedAsk: row.advised_ask,
    getIn: row.get_in,
    median: row.median,
    listingCount: row.listing_count,
    lastSale: row.last_sale,
    marketDetails: parseMarketDetails(row.market_details),
  }));
}

function parseMarketDetails(value: string | null): MarketDetails | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as MarketDetails;
  } catch {
    return null;
  }
}

export async function loadLiveBook(env: Env): Promise<Book> {
  const existing = await readDurableBook(env);
  if (existing?.games?.length) return existing;
  await writeBook(env, SEED_BOOK);
  return SEED_BOOK;
}

export async function readSpend(env: Env, now = new Date()): Promise<SpendState> {
  const etDate = etDateFrom(now);
  // Spend limits must read the durable value, never an eventually consistent KV cache.
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
    .bind(SPEND_KEY).first<{ value: string }>();
  const raw = row?.value ?? null;
  if (!raw) return emptySpendState(etDate);
  try {
    return rolloverSpend(JSON.parse(raw) as SpendState, etDate);
  } catch {
    return emptySpendState(etDate);
  }
}

export async function writeSpend(env: Env, spend: SpendState): Promise<void> {
  await writeStore(env, SPEND_KEY, JSON.stringify(spend));
}
