import { buildFreshnessReport, type FreshnessReport } from "../src/shared/freshness";
import { ensureArchive } from "./archive-store";
import { readBook, SEED_BOOK } from "./store";

const HEADERS = {
  "Cache-Control": "no-store",
};

const SOURCES_KEY = "freshness:sources:v1";
const TRACKED = ["seatdata", "apify"] as const;

async function sourceCheckedAt(env: Env): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = { seatdata: null, apify: null };
  try {
    const cached = await env.BOOK.get(SOURCES_KEY);
    if (cached) return JSON.parse(cached) as Record<string, string | null>;
  } catch (error) {
    console.error("freshness cache", error);
  }
  try {
    await ensureArchive(env);
    const rows = await env.DB.prepare(
      `SELECT source, MAX(pulled_at) AS pulled_at FROM price_pulls
       WHERE source IN ('seatdata', 'apify')
         AND trigger_name IN ('cron', 'http')
       GROUP BY source`,
    ).all<{ source: string; pulled_at: string | null }>();
    for (const row of rows.results ?? []) {
      if ((TRACKED as readonly string[]).includes(row.source)) out[row.source] = row.pulled_at;
    }
    // Short TTL: a new pull shows within 10 minutes.
    await env.BOOK.put(SOURCES_KEY, JSON.stringify(out), { expirationTtl: 600 });
  } catch (error) {
    console.error("freshness sources", error);
  }
  return out;
}

export async function freshnessResponse(env: Env, request: Request, now = new Date()): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...HEADERS, Allow: "GET" } },
    );
  }
  let games = SEED_BOOK.games;
  try {
    const book = await readBook(env);
    if (book?.games?.length) games = book.games;
  } catch (error) {
    console.error("freshness book", error);
  }
  const report: FreshnessReport = buildFreshnessReport({
    now,
    games,
    sourceCheckedAt: await sourceCheckedAt(env),
  });
  return Response.json(report, { headers: HEADERS });
}
