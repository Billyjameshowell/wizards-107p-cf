import { buildFreshnessReport, type FreshnessReport } from "../src/shared/freshness";
import { parseFlags, type SourceId } from "../src/shared/guardrails";
import { ensureArchive } from "./archive-store";
import { readBook, SEED_BOOK } from "./store";

const HEADERS = {
  "Cache-Control": "no-store",
};

const SOURCES_KEY = "freshness:sources:v1";

async function sourceCheckedAt(env: Env, sources: readonly SourceId[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = Object.fromEntries(sources.map((source) => [source, null]));
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
       WHERE trigger_name IN ('cron', 'http')
       GROUP BY source`,
    ).all<{ source: string; pulled_at: string | null }>();
    for (const row of rows.results ?? []) {
      if (row.source in out) out[row.source] = row.pulled_at;
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
  const sources = parseFlags(env).sources;
  const report: FreshnessReport = buildFreshnessReport({
    now,
    games,
    sources,
    sourceCheckedAt: await sourceCheckedAt(env, sources),
  });
  return Response.json(report, { headers: HEADERS });
}
