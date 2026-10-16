import { parseGridMetrics, pullNeedsArchive, recoverPullMetrics, buildPriceGrid, type GridPull } from "../src/shared/grid";
import { etYmd } from "../src/shared/pricing";
import type { TrendListing } from "../src/shared/trends";
import { ensureArchiveBackfill } from "./archive-store";
import { loadSuggestionInputs, loadSuggestedAsks, persistSuggestedAsks } from "./suggested-asks";

const HEADERS = { "Cache-Control": "no-store" };
const PAGE = 400;
const ARCHIVE_CAP = 30;

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
  payload_json: string | null;
  raw_key: string | null;
};

function parsePayload(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function loadGridPulls(env: Env): Promise<GridPull[]> {
  const pulls: GridPull[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT id, pulled_at, et_date, source, game_date, opponent, median, get_in, est_ask, live_ask,
              listing_count, comp_count, legacy_label, payload_json, raw_key
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
        estAsk: row.est_ask,
        liveAsk: row.live_ask,
        listingCount: row.listing_count,
        compCount: row.comp_count,
        legacyLabel: row.legacy_label,
        payload: parsePayload(row.payload_json),
        rawKey: row.raw_key,
      });
    }
    if (rows.length < PAGE) break;
    offset += rows.length;
  }
  return pulls;
}

async function loadGridListings(env: Env): Promise<TrendListing[]> {
  const listings: TrendListing[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT pull_id, section, row, quantity, price, active
       FROM price_listings
       WHERE price > 0
       ORDER BY id
       LIMIT ? OFFSET ?`,
    )
      .bind(PAGE, offset)
      .all<{
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
    }
    if (rows.length < PAGE) break;
    offset += rows.length;
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

/** Fill pulls whose prices live only in the gzipped R2 body. */
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

export async function gridResponse(env: Env, request: Request, now = new Date()): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
  }
  try {
    await ensureArchiveBackfill(env);
    const inputs = await loadSuggestionInputs(env);
    await persistSuggestedAsks(env, now, { inputs });
    const [pulls, listings, suggested] = await Promise.all([
      loadGridPulls(env),
      loadGridListings(env),
      loadSuggestedAsks(env),
    ]);
    await fillPullsFromArchive(env, pulls, listings);
    const url = new URL(request.url);
    const grid = buildPriceGrid({
      now,
      today: etYmd(now),
      games: inputs.games,
      pulls,
      listings,
      suggested,
      metrics: parseGridMetrics(url.searchParams.get("metrics")),
      team: url.searchParams.get("team"),
    });
    return Response.json(grid, { headers: HEADERS });
  } catch (error) {
    console.error("grid", error);
    return Response.json({ error: "unavailable" }, { status: 500, headers: HEADERS });
  }
}
