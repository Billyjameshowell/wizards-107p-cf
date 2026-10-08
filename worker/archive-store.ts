import legacyRows from "../data/legacy-price-history.json" with { type: "json" };
import {
  archiveStatusForAbort,
  planBookSnapshots,
  planLegacyArchive,
  planObservedPulls,
  planPriceHistoryArchive,
  pullFilter,
  type ArchivePull,
  type ArchiveSummary,
  type ExportQuery,
  type ObservedPull,
} from "../src/shared/archive";
import { ARCHIVE_DDL } from "../src/shared/archive-schema";
import type { MarketPoint } from "./adapters/types";
import { readBook } from "./store";

const BACKFILL_KEY = "archive_backfill_v1";
const INSERT_PULL = `INSERT INTO price_pulls (
  external_id, pulled_at, et_date, trigger_name, source, game_date, opponent, status,
  paid, cost_usd, http_status, error, listing_count, median, get_in, comp_count,
  excluded_dump, est_ask, live_ask, legacy_label, raw_key, raw_bytes, note, payload_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(external_id) DO NOTHING
RETURNING id`;

const INSERT_SUMMARY = `INSERT INTO price_run_summaries (
  external_id, pulled_at, et_date, source, sell_book_cash, vs_6k, payload_json
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(external_id) DO NOTHING`;

export function rowsForAdapter(args: {
  aborted?: string;
  paid: boolean;
  points: MarketPoint[];
  observations: ObservedPull[];
}): ObservedPull[] {
  if (args.observations.length > 0) return args.observations;
  if (args.aborted) {
    return [
      {
        gameDate: null,
        status: archiveStatusForAbort(args.aborted),
        error: args.aborted,
        paid: args.paid,
      },
    ];
  }
  return args.points.map((point) => ({
    gameDate: point.date,
    status: "ok" as const,
    paid: args.paid,
    median: point.compMedian ?? point.median ?? null,
    getIn: point.getIn ?? null,
    compCount: point.compCount ?? null,
    excludedDump: point.compExcludedDump === true,
    listingCount: point.listingCount ?? null,
  }));
}

let backfillTask: Promise<void> | null = null;

export function ensureArchiveBackfill(env: Env): Promise<void> {
  if (!backfillTask) {
    backfillTask = runBackfill(env).catch((error) => {
      backfillTask = null;
      throw error;
    });
  }
  return backfillTask;
}

export async function archiveObserved(
  env: Env,
  args: { trigger: string; now: Date; source: string; rows: ObservedPull[] },
): Promise<void> {
  if (args.rows.length === 0) return;
  await ensureArchive(env);
  const ids = args.rows.map(() => crypto.randomUUID());
  const pulls = planObservedPulls({
    source: args.source,
    trigger: args.trigger,
    now: args.now,
    rows: args.rows,
    ids,
  });
  await writePulls(env, pulls);
}

export async function ensureArchive(env: Env): Promise<void> {
  // D1 exec rejects leading -- comments and can choke on multi-statement DDL.
  // Run each statement alone (tables may already exist from migrations).
  const statements = ARCHIVE_DDL.split(";")
    .map((part) =>
      part
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trimEnd())
        .join("\n")
        .trim(),
    )
    .filter((sql) => sql.length > 0);
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
}

async function runBackfill(env: Env): Promise<void> {
  await ensureArchive(env);
  await ensureStore(env);
  const existing = await env.DB.prepare("SELECT value FROM store WHERE key = ?")
    .bind(BACKFILL_KEY)
    .first<{ value: string }>();
  if (existing?.value === "done") return;

  const legacy = planLegacyArchive(legacyRows as unknown[]);
  await writePulls(env, legacy.pulls);
  await writeSummaries(env, legacy.summaries);
  await copyPriceHistory(env);
  const book = await readBook(env);
  if (book) await writePulls(env, planBookSnapshots(book));

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO store (key, value, updated_at) VALUES (?, 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = excluded.updated_at`,
  )
    .bind(BACKFILL_KEY, now)
    .run();
}

async function ensureStore(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
}

async function copyPriceHistory(env: Env): Promise<void> {
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'price_history'",
  ).first<{ name: string }>();
  if (!table) return;
  const info = await env.DB.prepare("PRAGMA table_info(price_history)").all<{ name: string }>();
  const columns = (info.results ?? []).map((row) => row.name);
  if (columns.length === 0) return;
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare("SELECT * FROM price_history LIMIT 100 OFFSET ?")
      .bind(offset)
      .all<Record<string, unknown>>();
    const rows = page.results ?? [];
    if (rows.length === 0) break;
    await writePulls(env, planPriceHistoryArchive(columns, rows));
    offset += rows.length;
    if (rows.length < 100) break;
  }
}

async function writeSummaries(env: Env, summaries: readonly ArchiveSummary[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const summary of summaries) {
    statements.push(
      env.DB.prepare(INSERT_SUMMARY).bind(
        summary.externalId,
        summary.pulledAt,
        summary.etDate,
        summary.source,
        summary.sellBookCash,
        summary.vs6k,
        JSON.stringify(summary.payload),
      ),
    );
  }
  await runBatches(env, statements);
}

async function writePulls(env: Env, pulls: readonly ArchivePull[]): Promise<void> {
  const stored: { pull: ArchivePull; rawKey: string | null; rawBytes: number | null }[] = [];
  for (const pull of pulls) {
    const raw = await putRaw(env, pull);
    stored.push({ pull, rawKey: raw?.key ?? null, rawBytes: raw?.bytes ?? null });
  }
  const statements = stored.map(({ pull, rawKey, rawBytes }) =>
    env.DB.prepare(INSERT_PULL).bind(
      pull.externalId,
      pull.pulledAt,
      pull.etDate,
      pull.trigger,
      pull.source,
      pull.gameDate,
      pull.opponent,
      pull.status,
      pull.paid ? 1 : 0,
      pull.costUsd,
      pull.httpStatus,
      pull.error,
      pull.listingCount,
      pull.median,
      pull.getIn,
      pull.compCount,
      pull.excludedDump ? 1 : 0,
      pull.estAsk,
      pull.liveAsk,
      pull.legacyLabel,
      rawKey,
      rawBytes,
      pull.note,
      pull.payload == null ? null : JSON.stringify(pull.payload),
    ),
  );
  const listingStatements: D1PreparedStatement[] = [];
  const size = 20;
  for (let index = 0; index < statements.length; index += size) {
    const slice = statements.slice(index, index + size);
    const results = slice.length === 1 ? [await slice[0]!.all<{ id: number }>()] : await env.DB.batch<{ id: number }>(slice);
    results.forEach((result, offset) => {
      const pullId =
        result.results?.[0]?.id ??
        (slice.length === 1 && result.meta?.changes === 1 ? result.meta.last_row_id : undefined);
      const pull = stored[index + offset]?.pull;
      if (!pullId || !pull || pull.listings.length === 0) return;
      for (const listing of pull.listings) {
        listingStatements.push(
          env.DB.prepare(
            `INSERT INTO price_listings (
               pull_id, game_date, section, row, quantity, price, active, extra_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            pullId,
            pull.gameDate,
            listing.section,
            listing.row,
            listing.quantity,
            listing.price,
            listing.active,
            Object.keys(listing.extra).length > 0 ? JSON.stringify(listing.extra) : null,
          ),
        );
      }
    });
  }
  await runBatches(env, listingStatements);
}

async function runBatches(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  const size = 40;
  for (let index = 0; index < statements.length; index += size) {
    await env.DB.batch(statements.slice(index, index + size));
  }
}

function rawObjectKey(pull: ArchivePull): string {
  const id = pull.externalId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180);
  const day = pull.etDate || "undated";
  return `raw/${day}/${pull.source}/${id}.json.gz`;
}

async function putRaw(
  env: Env,
  pull: ArchivePull,
): Promise<{ key: string; bytes: number } | null> {
  if (pull.raw == null) return null;
  const bucket = env.ARCHIVE;
  if (!bucket) return null;
  try {
    const json = JSON.stringify(pull.raw);
    const bytes = await gzipUtf8(json);
    const key = rawObjectKey(pull);
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });
    return { key, bytes: bytes.byteLength };
  } catch (error) {
    console.error("price archive raw", error);
    return null;
  }
}

async function gzipUtf8(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const PULL_COLUMNS = `id, external_id, pulled_at, et_date, trigger_name, source, legacy_label,
  game_date, opponent, status, paid, cost_usd, http_status, error, listing_count, median,
  get_in, comp_count, excluded_dump, est_ask, live_ask, note, raw_key, payload_json`;

export async function queryPulls(
  env: Env,
  query: ExportQuery,
): Promise<Record<string, unknown>[]> {
  const filter = pullFilter(query, "");
  const result = await env.DB.prepare(
    `SELECT ${PULL_COLUMNS} FROM price_pulls ${filter.sql}
     ORDER BY pulled_at, id LIMIT ? OFFSET ?`,
  )
    .bind(...filter.binds, query.limit, query.offset)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function queryListings(
  env: Env,
  query: ExportQuery,
): Promise<Record<string, unknown>[]> {
  const filter = pullFilter(query, "p");
  const result = await env.DB.prepare(
    `SELECT l.pull_id, p.pulled_at, p.et_date, p.source, p.legacy_label, p.game_date, p.opponent,
            p.status, p.paid, p.cost_usd, p.median, p.get_in, p.comp_count, p.est_ask, p.live_ask,
            l.section, l.row, l.quantity, l.price, l.active, l.extra_json
     FROM price_listings l
     INNER JOIN price_pulls p ON p.id = l.pull_id
     ${filter.sql}
     ORDER BY p.pulled_at, l.id
     LIMIT ? OFFSET ?`,
  )
    .bind(...filter.binds, query.limit, query.offset)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function querySummaries(
  env: Env,
  query: ExportQuery,
): Promise<Record<string, unknown>[]> {
  const filter = summaryFilter(query);
  const result = await env.DB.prepare(
    `SELECT id, pulled_at, et_date, source, sell_book_cash, vs_6k, payload_json
     FROM price_run_summaries ${filter.sql}
     ORDER BY pulled_at, id
     LIMIT ? OFFSET ?`,
  )
    .bind(...filter.binds, query.limit, query.offset)
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function countPulls(env: Env, query: ExportQuery): Promise<number> {
  const filter = pullFilter(query, "");
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM price_pulls ${filter.sql}`)
    .bind(...filter.binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countListings(env: Env, query: ExportQuery): Promise<number> {
  const filter = pullFilter(query, "p");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM price_listings l
     INNER JOIN price_pulls p ON p.id = l.pull_id ${filter.sql}`,
  )
    .bind(...filter.binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countSummaries(env: Env, query: ExportQuery): Promise<number> {
  const filter = summaryFilter(query);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM price_run_summaries ${filter.sql}`)
    .bind(...filter.binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function summaryFilter(query: ExportQuery) {
  if (query.game) return { sql: "WHERE 0", binds: [] };
  return pullFilter({ ...query, game: null }, "");
}
