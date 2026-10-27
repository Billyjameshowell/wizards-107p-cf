import {
  planRecomputedAsks,
  planSnapshotAsks,
  type SuggestedAskDraft,
} from "../src/shared/grid";
import { etYmd } from "../src/shared/pricing";
import { ensureArchive } from "./archive-store";
import { D1_PAGE, loadMarketInputs, type MarketInputs } from "./trends";

const FLAG = "suggested_backfill_v1";
const INSERT = `INSERT INTO suggested_asks (
  external_id, game_date, et_date, recorded_at, ask, origin, source, pulled_at, method
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(external_id) DO NOTHING`;


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
 * The grid and trends caches are rebuilt by their own cron steps afterwards (schedule.ts).
 */
export async function persistSuggestedAsks(
  env: Env,
  now = new Date(),
  options?: { fillToday?: boolean; inputs?: MarketInputs },
): Promise<void> {
  await ensureArchive(env);
  const today = etYmd(now);
  const recordedAt = now.toISOString();
  const inputs = options?.inputs ?? (await loadMarketInputs(env));
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
       LIMIT ?`,
    )
      .bind(after, D1_PAGE)
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
    if (batch.length < D1_PAGE) break;
  }
  return rows;
}
