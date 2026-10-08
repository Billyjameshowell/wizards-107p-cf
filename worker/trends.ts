import type { Game } from "../src/shared/book";
import { compMedianOf, demandOf, etYmd } from "../src/shared/pricing";
import {
  buildTrendsReport,
  type TrendListing,
  type TrendPull,
  type TrendsGameSeed,
} from "../src/shared/trends";
import { ensureArchiveBackfill } from "./archive-store";
import { loadLiveBook } from "./store";

const PAGE = 400;

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
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, pulled_at, et_date, source, game_date, opponent, median, get_in, live_ask,
              comp_count, listing_count, legacy_label,
              CASE WHEN source = 'legacy-box' THEN payload_json ELSE NULL END AS payload_json
       FROM price_pulls
       WHERE game_date IS NOT NULL
       ORDER BY id
       LIMIT ? OFFSET ?`,
    )
      .bind(PAGE, offset)
      .all<PullSql>();
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
        liveAsk: row.live_ask,
        compCount: row.comp_count,
        listingCount: row.listing_count,
        legacyLabel: row.legacy_label,
        payload: parsePayload(row.payload_json, row.source),
      });
    }
    if (rows.length < PAGE) break;
    offset += rows.length;
  }
  return pulls;
}

export async function loadTrendListings(env: Env): Promise<TrendListing[]> {
  const listings: TrendListing[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, pull_id, section, row, quantity, price, active
       FROM price_listings
       WHERE price > 0
       ORDER BY id
       LIMIT ? OFFSET ?`,
    )
      .bind(PAGE, offset)
      .all<ListingSql>();
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
    }
    if (rows.length < PAGE) break;
    offset += rows.length;
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
  };
}

export async function trendsResponse(env: Env, now = new Date()): Promise<Response> {
  try {
    await ensureArchiveBackfill(env);
    const book = await loadLiveBook(env);
    const [pulls, listings] = await Promise.all([loadTrendPulls(env), loadTrendListings(env)]);
    const report = buildTrendsReport({
      today: etYmd(now),
      section: book.section,
      row: book.row,
      seats: book.seats,
      games: book.games.map(toSeed),
      pulls,
      listings,
    });
    return Response.json(report, {
      headers: { "Cache-Control": "public, max-age=120" },
    });
  } catch (error) {
    console.error("trends", error);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
}
