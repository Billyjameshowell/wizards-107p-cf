import type { Book } from "../src/shared/book";
import {
  emptySpendState,
  etDateFrom,
  rolloverSpend,
  type SpendState,
} from "../src/shared/guardrails";
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
