import type { Book } from "../src/shared/book";
import {
  emptySpendState,
  etDateFrom,
  rolloverSpend,
  type SpendState,
} from "../src/shared/guardrails";
import {
  HISTORY_KEEP_DAYS,
  compHistoryFromRows,
  type CompObservation,
} from "../src/shared/price-history";
import seedBook from "../data/seed-book.json" with { type: "json" };

const BOOK_KEY = "book";
const SPEND_KEY = "spend";

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

async function readStore(env: Env, key: string): Promise<string | null> {
  try {
    const fromKv = await env.BOOK.get(key);
    if (fromKv) return fromKv;
  } catch {
    // KV may be unbound in a broken local setup; fall through to D1.
  }
  try {
    await ensureTable(env);
    const row = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
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

export async function writeBook(env: Env, book: Book): Promise<void> {
  await writeStore(env, BOOK_KEY, JSON.stringify(book));
}

export async function loadLiveBook(env: Env): Promise<Book> {
  const existing = await readBook(env);
  if (existing?.games?.length) return existing;
  await writeBook(env, SEED_BOOK);
  return SEED_BOOK;
}

export async function readSpend(env: Env, now = new Date()): Promise<SpendState> {
  const etDate = etDateFrom(now);
  const raw = await readStore(env, SPEND_KEY);
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

export type PriceHistoryWrite = {
  gameDate: string;
  source: "seatdata" | "apify";
  etDate: string;
  pulledAt: string;
  median: number | null;
  getIn: number | null;
  listingCount: number | null;
  compCount: number | null;
  excludedDump: boolean;
};

const PRICE_HISTORY_SQL = `CREATE TABLE IF NOT EXISTS price_history (
  game_date TEXT NOT NULL,
  source TEXT NOT NULL,
  et_date TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  median REAL,
  get_in REAL,
  listing_count INTEGER,
  comp_count INTEGER,
  excluded_dump INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_date, source, et_date)
)`;

async function ensurePriceHistory(env: Env): Promise<void> {
  await env.DB.exec(PRICE_HISTORY_SQL);
}

export async function recordPriceHistory(
  env: Env,
  rows: PriceHistoryWrite[],
  now: Date,
): Promise<void> {
  await ensurePriceHistory(env);
  const cutoff = etDateFrom(new Date(now.getTime() - HISTORY_KEEP_DAYS * 86_400_000));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM price_history WHERE et_date < ?").bind(cutoff),
  ];
  for (const row of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO price_history (
           game_date, source, et_date, pulled_at, median, get_in, listing_count, comp_count, excluded_dump
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_date, source, et_date) DO UPDATE SET
           pulled_at = excluded.pulled_at,
           median = excluded.median,
           get_in = excluded.get_in,
           listing_count = excluded.listing_count,
           comp_count = excluded.comp_count,
           excluded_dump = excluded.excluded_dump`,
      ).bind(
        row.gameDate,
        row.source,
        row.etDate,
        row.pulledAt,
        row.median,
        row.getIn,
        row.listingCount,
        row.compCount,
        row.excludedDump ? 1 : 0,
      ),
    );
  }
  const size = 40;
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
}

export async function readCompHistory(env: Env): Promise<Map<string, CompObservation[]>> {
  await ensurePriceHistory(env);
  const result = await env.DB.prepare(
    `SELECT game_date, source, et_date, pulled_at, median, comp_count, excluded_dump
     FROM price_history
     WHERE source = 'seatdata'`,
  ).all<{
    game_date: string;
    source: string;
    et_date: string;
    pulled_at: string;
    median: number | null;
    comp_count: number | null;
    excluded_dump: number | null;
  }>();
  return compHistoryFromRows(
    (result.results ?? []).map((row) => ({
      gameDate: row.game_date,
      source: row.source,
      etDate: row.et_date,
      pulledAt: row.pulled_at,
      median: row.median,
      compCount: row.comp_count,
      excludedDump: row.excluded_dump === 1,
    })),
  );
}
