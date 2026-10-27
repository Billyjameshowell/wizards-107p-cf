import type { Game } from "../src/shared/book";
import type { LoggedInstantOffer } from "../src/shared/instant-offer";
import { SEASON_CUSHION_DEFAULT } from "../src/shared/price-model";
import { compMedianOf, demandOf, etYmd } from "../src/shared/pricing";
import {
  buildTrendsReport,
  type TrendListing,
  type TrendPull,
  type TrendsGameSeed,
} from "../src/shared/trends";
import { ensureArchiveBackfill } from "./archive-store";
import { loadInstantOffers } from "./instant-offers";
import { loadCertainSales } from "./likely-sales";
import { loadLiveBook } from "./store";

/**
 * Rows per D1 read. Each page is one call against the per-invocation limit on calls to
 * Cloudflare services; at 400 a full listings read (~74k rows) took ~185 calls, and the
 * old one-shot cron made five of them. Rows are small, so 5,000 is a few hundred KB.
 */
export const D1_PAGE = 5000;

type PullSql = {
  id: number;
  pulled_at: string;
  et_date: string;
  source: string;
  game_date: string | null;
  opponent: string | null;
  median: number | null;
  get_in: number | null;
  live_ask: number | null;
  comp_count: number | null;
  listing_count: number | null;
  legacy_label: string | null;
  payload_json: string | null;
};

type ListingSql = {
  id: number;
  pull_id: number;
  section: string | null;
  row: string | null;
  quantity: number | null;
  price: number | null;
  active: number | null;
};

function parsePayload(value: string | null, source: string): unknown {
  if (source !== "legacy-box" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function loadTrendPulls(env: Env): Promise<TrendPull[]> {
  const pulls: TrendPull[] = [];
  let after = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, pulled_at, et_date, source, game_date, opponent, median, get_in, live_ask,
              comp_count, listing_count, legacy_label,
              CASE WHEN source = 'legacy-box' THEN payload_json ELSE NULL END AS payload_json
       FROM price_pulls
       WHERE game_date IS NOT NULL AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
      .bind(after, D1_PAGE)
      .all<PullSql>();
    const rows = page.results ?? [];
    for (const row of rows) {
      after = row.id;
      pulls.push({
        id: row.id,
        pulledAt: row.pulled_at,
        etDate: row.et_date,
        source: row.source,
        gameDate: row.game_date,
        opponent: row.opponent,
        median: row.median,
        getIn: row.get_in,
        liveAsk: row.live_ask,
        compCount: row.comp_count,
        listingCount: row.listing_count,
        legacyLabel: row.legacy_label,
        payload: parsePayload(row.payload_json, row.source),
      });
    }
    if (rows.length < D1_PAGE) break;
  }
  return pulls;
}

export async function loadTrendListings(env: Env): Promise<TrendListing[]> {
  const listings: TrendListing[] = [];
  // Keyset paging (id > last). OFFSET paging re-read every skipped row and made each
  // trends rebuild read O(n^2 / page size) rows, the main D1 free-tier drain.
  let after = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, pull_id, section, row, quantity, price, active
       FROM price_listings
       WHERE price > 0 AND id > ?
       ORDER BY id
       LIMIT ?`,
    )
      .bind(after, D1_PAGE)
      .all<ListingSql>();
    const rows = page.results ?? [];
    for (const row of rows) {
      after = row.id;
      listings.push({
        pullId: row.pull_id,
        section: row.section,
        row: row.row,
        quantity: row.quantity,
        price: row.price,
        active: row.active,
      });
    }
    if (rows.length < D1_PAGE) break;
  }
  return listings;
}

export function toSeed(game: Game): TrendsGameSeed {
  return {
    date: game.date,
    opponent: game.opponent,
    weekday: game.weekday,
    timeEt: game.time_et,
    type: game.type,
    demand: demandOf(game),
    bookMedian: compMedianOf(game),
    notes: game.notes,
    sitOrSell: game.sit_or_sell,
    sold: game.sold,
    listedAsk: game.listed_ask,
    soldKeepTotal: game.sold_keep_total ?? null,
  };
}

/** Everything the model reads: one load per cron step, shared by the fit, the snapshot and likely sales. */
export type MarketInputs = {
  games: TrendsGameSeed[];
  pulls: TrendPull[];
  listings: TrendListing[];
  instantOffers: LoggedInstantOffer[];
};

export async function loadMarketInputs(env: Env): Promise<MarketInputs> {
  const book = await loadLiveBook(env);
  const [pulls, listings, instantOffers] = await Promise.all([
    loadTrendPulls(env),
    loadTrendListings(env),
    loadInstantOffers(env),
  ]);
  return { games: book.games.map(toSeed), pulls, listings, instantOffers };
}

function cushionOf(env: Env): number {
  const raw = env.SEASON_CUSHION?.trim();
  if (!raw) return SEASON_CUSHION_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return SEASON_CUSHION_DEFAULT;
  return parsed;
}

export const TRENDS_CACHE_KEY = "trends:v1";

async function buildTrends(env: Env, now: Date) {
  await ensureArchiveBackfill(env);
  const book = await loadLiveBook(env);
  const [pulls, listings, certainSales, instantOffers] = await Promise.all([
    loadTrendPulls(env),
    loadTrendListings(env),
    loadCertainSales(env),
    loadInstantOffers(env),
  ]);
  return buildTrendsReport({
    today: etYmd(now),
    section: book.section,
    row: book.row,
    seats: book.seats,
    games: book.games.map(toSeed),
    pulls,
    listings,
    breakEven: book.season_cost,
    cushion: cushionOf(env),
    certainSales,
    instantOffers,
  });
}

/** Recompute the trends report and store it in KV. The daily cron calls this. */
export async function refreshTrends(env: Env, now = new Date()): Promise<string> {
  const raw = JSON.stringify(await buildTrends(env, now));
  await env.BOOK.put(TRENDS_CACHE_KEY, raw);
  return raw;
}

/** Serve the cached report; rebuild on a miss or when it is from an earlier ET day. */
export async function trendsResponse(env: Env, now = new Date()): Promise<Response> {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120" };
  try {
    let raw: string | null = null;
    try {
      raw = await env.BOOK.get(TRENDS_CACHE_KEY);
    } catch (error) {
      console.error("trends cache", error);
    }
    const today = etYmd(now);
    if (raw && raw.includes(`"today":"${today}"`)) return new Response(raw, { headers });
    raw = await refreshTrends(env, now);
    return new Response(raw, { headers });
  } catch (error) {
    console.error("trends", error);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
}
