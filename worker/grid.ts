import {
  buildPriceGrid,
  parseGridMetrics,
  pullNeedsArchive,
  recoverPullMetrics,
  slicePriceGrid,
  type GridPull,
  type PriceGrid,
} from "../src/shared/grid";
import { etYmd } from "../src/shared/pricing";
import type { TrendListing } from "../src/shared/trends";
import { loadLiveBook } from "./store";
import { loadSuggestedAsks } from "./suggested-asks";
import { D1_PAGE, toSeed } from "./trends";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ARCHIVE_CAP = 30;

/** KV copy of the full grid. Requests read this and never rebuild it. */
export const GRID_CACHE_KEY = "grid:v1";

/**
 * Game pulls only, in id order. Payload stays in D1; the few fields the grid
 * reads are extracted here. `idx_price_pulls_grid` is the id range of those rows.
 */
export const GRID_PULL_SQL = `SELECT id, pulled_at, et_date, source, game_date, opponent,
            median, get_in, est_ask, live_ask, listing_count, comp_count, legacy_label, raw_key,
            json_extract(payload_json, '$.going_price') AS going_price,
            json_extract(payload_json, '$.ask_per_ticket') AS ask_per_ticket,
            json_extract(payload_json, '$.get_in') AS payload_get_in,
            json_extract(payload_json, '$.est_107_ask') AS payload_est,
            json_extract(payload_json, '$.live_107_ask') AS payload_live
     FROM price_pulls
     WHERE game_date IS NOT NULL AND id > ?
     ORDER BY id
     LIMIT ?`;

/** Priced listings only. `idx_price_listings_priced` covers this id range. */
export const GRID_LISTING_SQL = `SELECT id, pull_id, section, row, quantity, price, active
     FROM price_listings
     WHERE price > 0 AND id > ?
     ORDER BY id
     LIMIT ?`;

type PullSql = {
  id: number;
  pulled_at: string;
  et_date: string;
  source: string;
  game_date: string | null;
  opponent: string | null;
  median: number | null;
  get_in: number | null;
  est_ask: number | null;
  live_ask: number | null;
  listing_count: number | null;
  comp_count: number | null;
  legacy_label: string | null;
  raw_key: string | null;
  going_price: number | string | null;
  ask_per_ticket: number | string | null;
  payload_get_in: number | string | null;
  payload_est: number | string | null;
  payload_live: number | string | null;
};

function extractedPayload(row: PullSql): Record<string, number | string> | null {
  const payload: Record<string, number | string> = {};
  if (row.going_price != null) payload.going_price = row.going_price;
  if (row.ask_per_ticket != null) payload.ask_per_ticket = row.ask_per_ticket;
  if (row.payload_get_in != null) payload.get_in = row.payload_get_in;
  if (row.payload_est != null) payload.est_107_ask = row.payload_est;
  if (row.payload_live != null) payload.live_107_ask = row.payload_live;
  return Object.keys(payload).length > 0 ? payload : null;
}

async function loadGridPulls(env: Env): Promise<GridPull[]> {
  const pulls: GridPull[] = [];
  let after = 0;
  for (;;) {
    const page = await env.DB.prepare(GRID_PULL_SQL).bind(after, D1_PAGE).all<PullSql>();
    const rows = page.results ?? [];
    for (const row of rows) {
      pulls.push({
        id: row.id,
        pulledAt: row.pulled_at,
        etDate: row.et_date,
        source: row.source,
        gameDate: row.game_date,
        opponent: row.opponent,
        median: row.median,
        getIn: row.get_in,
        estAsk: row.est_ask,
        liveAsk: row.live_ask,
        listingCount: row.listing_count,
        compCount: row.comp_count,
        legacyLabel: row.legacy_label,
        payload: extractedPayload(row),
        rawKey: row.raw_key,
      });
      after = row.id;
    }
    if (rows.length < D1_PAGE) break;
  }
  return pulls;
}

async function loadGridListings(env: Env): Promise<TrendListing[]> {
  const listings: TrendListing[] = [];
  let after = 0;
  for (;;) {
    const page = await env.DB.prepare(GRID_LISTING_SQL)
      .bind(after, D1_PAGE)
      .all<{
        id: number;
        pull_id: number;
        section: string | null;
        row: string | null;
        quantity: number | null;
        price: number | null;
        active: number | null;
      }>();
    const rows = page.results ?? [];
    for (const row of rows) {
      listings.push({
        pullId: row.pull_id,
        section: row.section,
        row: row.row,
        quantity: row.quantity,
        price: row.price,
        active: row.active,
      });
      after = row.id;
    }
    if (rows.length < D1_PAGE) break;
  }
  return listings;
}

async function readArchiveJson(bucket: R2Bucket, key: string): Promise<unknown | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const bytes = await object.arrayBuffer();
  let text: string;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } catch {
    text = new TextDecoder().decode(bytes);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Fill pulls whose prices live only in the gzipped R2 body. Cron rebuild only. */
export async function fillPullsFromArchive(env: Env, pulls: GridPull[], listings: TrendListing[]): Promise<void> {
  const bucket = env.ARCHIVE;
  if (!bucket) return;
  const seen = new Set(listings.map((row) => row.pullId));
  const pending = pulls.filter((pull) => pullNeedsArchive(pull, seen)).slice(0, ARCHIVE_CAP);
  for (const pull of pending) {
    if (!pull.rawKey) continue;
    try {
      const body = await readArchiveJson(bucket, pull.rawKey);
      const recovered = body ? recoverPullMetrics(body) : null;
      if (!recovered) continue;
      if (pull.median == null) pull.median = recovered.median;
      if (pull.getIn == null) pull.getIn = recovered.getIn;
      if (pull.estAsk == null) pull.estAsk = recovered.estAsk;
      if (pull.liveAsk == null) pull.liveAsk = recovered.liveAsk;
      if (pull.listingCount == null) pull.listingCount = recovered.listingCount;
      if (pull.compCount == null) pull.compCount = recovered.compCount;
      for (const listing of recovered.listings) {
        listings.push({ pullId: pull.id, ...listing });
      }
    } catch (error) {
      console.error("grid archive", error);
    }
  }
}

/**
 * Build the full grid from D1 and store it in KV.
 * Called from the morning cron, after suggested-ask writes. Not from a page request.
 */
export async function refreshPriceGrid(env: Env, now = new Date()): Promise<void> {
  const book = await loadLiveBook(env);
  const [pulls, listings, suggested] = await Promise.all([
    loadGridPulls(env),
    loadGridListings(env),
    loadSuggestedAsks(env, { ready: true }),
  ]);
  await fillPullsFromArchive(env, pulls, listings);
  const grid = buildPriceGrid({
    now,
    today: etYmd(now),
    games: book.games.map(toSeed),
    pulls,
    listings,
    suggested,
  });
  await env.BOOK.put(GRID_CACHE_KEY, JSON.stringify(grid));
}

/**
 * Serve the cached grid. Metric and team filters are a slice of that JSON.
 * This does not read D1, recompute suggestions, or backfill.
 */
export async function gridResponse(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
  }
  let raw: string | null = null;
  try {
    raw = await env.BOOK.get(GRID_CACHE_KEY);
  } catch (error) {
    console.error("grid cache", error);
  }
  if (!raw) {
    return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
  const url = new URL(request.url);
  const metrics = url.searchParams.get("metrics");
  const team = url.searchParams.get("team");
  if (!metrics?.trim() && !team?.trim()) {
    return new Response(raw, { headers: HEADERS });
  }
  try {
    const grid = slicePriceGrid(JSON.parse(raw) as PriceGrid, {
      metrics: metrics?.trim() ? parseGridMetrics(metrics) : null,
      team,
    });
    return Response.json(grid, { headers: HEADERS });
  } catch (error) {
    console.error("grid", error);
    return Response.json({ error: "unavailable" }, { status: 500, headers: HEADERS });
  }
}
