import type { LoggedInstantOffer } from "../src/shared/instant-offer";
import {
  planRecomputedAsks,
  planSnapshotAsks,
  type SuggestedAskDraft,
} from "../src/shared/grid";
import { etYmd } from "../src/shared/pricing";
import type { TrendListing, TrendPull, TrendsGameSeed } from "../src/shared/trends";
import { ensureArchive } from "./archive-store";
import { loadInstantOffers } from "./instant-offers";
import { loadLiveBook } from "./store";
import { loadTrendListings, loadTrendPulls, toSeed } from "./trends";

const FLAG = "suggested_backfill_v1";
const INSERT = `INSERT INTO suggested_asks (
  external_id, game_date, et_date, recorded_at, ask, origin, source, pulled_at, method
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(external_id) DO NOTHING`;

export type SuggestionInputs = {
  games: TrendsGameSeed[];
  pulls: TrendPull[];
  listings: TrendListing[];
  instantOffers: LoggedInstantOffer[];
};

async function ensureStore(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
}

async function backfillDone(env: Env): Promise<boolean> {
  await ensureStore(env);
  const row = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
    .bind(FLAG)
    .first<{ value: string }>();
  return row?.value === "done";
}

async function markBackfill(env: Env, now: Date): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO store (key, value, updated_at) VALUES (?, 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = excluded.updated_at`,
  )
    .bind(FLAG, now.toISOString())
    .run();
}

export async function loadSuggestionInputs(env: Env): Promise<SuggestionInputs> {
  await ensureArchive(env);
  const book = await loadLiveBook(env);
  const [pulls, listings, instantOffers] = await Promise.all([
    loadTrendPulls(env),
    loadTrendListings(env),
    loadInstantOffers(env),
  ]);
  return {
    games: book.games.map(toSeed),
    pulls,
    listings,
    instantOffers,
  };
}

async function insertSuggested(env: Env, rows: readonly SuggestedAskDraft[]): Promise<void> {
  const size = 30;
  for (let index = 0; index < rows.length; index += size) {
    const slice = rows.slice(index, index + size);
    const statements = slice.map((row) =>
      env.DB.prepare(INSERT).bind(
        row.externalId,
        row.gameDate,
        row.etDate,
        row.recordedAt,
        row.ask,
        row.origin,
        row.source,
        row.pulledAt,
        row.method,
      ),
    );
    if (statements.length === 1) await statements[0]?.run();
    else if (statements.length > 1) await env.DB.batch(statements);
  }
}

async function hasTodaySnapshot(env: Env, today: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM suggested_asks WHERE et_date = ? AND origin = 'snapshot' LIMIT 1`,
  )
    .bind(today)
    .first<{ id: number }>();
  return row != null;
}

/**
 * Backfill past days once, then save today's model ask.
 * Inserts use ON CONFLICT DO NOTHING, so a saved ask is never replaced.
 * Cron only (`fillToday` from the morning refit). A page request must not call this.
 * After the write, the precomputed grid in KV is refreshed.
 */
export async function persistSuggestedAsks(
  env: Env,
  now = new Date(),
  options?: { fillToday?: boolean; inputs?: SuggestionInputs },
): Promise<void> {
  try {
    await ensureArchive(env);
    const today = etYmd(now);
    const recordedAt = now.toISOString();
    const inputs = options?.inputs ?? (await loadSuggestionInputs(env));
    if (!(await backfillDone(env))) {
      const recomputed = planRecomputedAsks({
        asOf: today,
        today,
        recordedAt,
        games: inputs.games,
        pulls: inputs.pulls,
        listings: inputs.listings,
        instantOffers: inputs.instantOffers,
      });
      await insertSuggested(env, recomputed);
      await markBackfill(env, now);
    }
    if (!options?.fillToday && (await hasTodaySnapshot(env, today))) return;
    const snapshot = planSnapshotAsks({
      asOf: today,
      recordedAt,
      games: inputs.games,
      pulls: inputs.pulls,
      listings: inputs.listings,
      instantOffers: inputs.instantOffers,
    });
    await insertSuggested(env, snapshot);
  } finally {
    await refreshGridCache(env, now);
  }
}

async function refreshGridCache(env: Env, now: Date): Promise<void> {
  try {
    const { refreshPriceGrid } = await import("./grid");
    await refreshPriceGrid(env, now);
  } catch (error) {
    console.error("price grid", error);
  }
  try {
    const { refreshTrends } = await import("./trends");
    await refreshTrends(env, now);
  } catch (error) {
    console.error("trends cache", error);
  }
}

/** `ready` skips CREATE TABLE. The cron calls this after ensureArchive. */
export async function loadSuggestedAsks(env: Env, options?: { ready?: boolean }): Promise<SuggestedAskDraft[]> {
  if (!options?.ready) await ensureArchive(env);
  const rows: SuggestedAskDraft[] = [];
  let after = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, external_id, game_date, et_date, recorded_at, ask, origin, source, pulled_at, method
       FROM suggested_asks
       WHERE id > ?
       ORDER BY id
       LIMIT 400`,
    )
      .bind(after)
      .all<{
        id: number;
        external_id: string;
        game_date: string;
        et_date: string;
        recorded_at: string;
        ask: number;
        origin: string;
        source: string;
        pulled_at: string;
        method: string;
      }>();
    const batch = page.results ?? [];
    for (const row of batch) {
      after = row.id;
      if (row.origin !== "snapshot" && row.origin !== "recomputed") continue;
      if (row.method !== "model" && row.method !== "day-rules") continue;
      rows.push({
        externalId: row.external_id,
        gameDate: row.game_date,
        etDate: row.et_date,
        recordedAt: row.recorded_at,
        ask: row.ask,
        origin: row.origin,
        source: row.source,
        pulledAt: row.pulled_at,
        method: row.method,
      });
    }
    if (batch.length < 400) break;
  }
  return rows;
}
