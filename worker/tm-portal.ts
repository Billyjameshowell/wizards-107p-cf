import type { TmPortalRead } from "../src/shared/book";
import { authorizeBearer } from "../src/shared/guardrails";

const DDL = `CREATE TABLE IF NOT EXISTS tm_portal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date TEXT NOT NULL,
  event_id TEXT,
  read_at TEXT NOT NULL,
  suggested REAL,
  range_low REAL,
  range_high REAL,
  sell_now REAL,
  listed_price REAL,
  status TEXT,
  note TEXT,
  created_at TEXT NOT NULL
)`;

async function ensure(env: Env): Promise<void> {
  await env.DB.prepare(DDL).run();
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const CACHE_KEY = "tm_portal:latest:v1";

/** Newest read per game, from KV. Rebuilt from D1 only on a miss or after a POST. */
export async function latestTmReads(env: Env): Promise<Record<string, TmPortalRead>> {
  try {
    const cached = await env.BOOK.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as Record<string, TmPortalRead>;
  } catch (error) {
    console.error("tm_portal cache", error);
  }
  const fresh = await latestTmReadsFromDb(env);
  if (fresh) await env.BOOK.put(CACHE_KEY, JSON.stringify(fresh)).catch(() => undefined);
  return fresh ?? {};
}

async function latestTmReadsFromDb(env: Env): Promise<Record<string, TmPortalRead> | null> {
  try {
    await ensure(env);
    // Newest row per game, but keep the newest TM suggestion/range/Sell Now even when a later
    // row only records a listing change. Table is tiny (a few rows per game).
    const rows = await env.DB.prepare(`SELECT * FROM tm_portal ORDER BY id`).all<TmPortalRead & { game_date: string }>();
    const out: Record<string, TmPortalRead> = {};
    for (const r of rows.results ?? []) {
      const prev = out[r.game_date];
      const hasSugg = r.suggested != null;
      out[r.game_date] = {
        read_at: r.read_at, event_id: r.event_id ?? prev?.event_id ?? null,
        suggested: hasSugg ? r.suggested : (prev?.suggested ?? null),
        range_low: hasSugg ? r.range_low : (prev?.range_low ?? null),
        range_high: hasSugg ? r.range_high : (prev?.range_high ?? null),
        sell_now: hasSugg ? r.sell_now : (prev?.sell_now ?? null),
        suggested_read_at: hasSugg ? r.read_at : (prev?.suggested_read_at ?? null),
        listed_price: r.listed_price ?? (r.status === "not listed" ? null : prev?.listed_price ?? null),
        status: r.status, note: r.note,
      };
    }
    return out;
  } catch (error) {
    console.error("tm_portal", error);
    return null;
  }
}

/** GET: all reads. POST (Bearer CRON_SECRET): append one read or an array of reads. */
export async function tmPortalResponse(request: Request, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!authorizeBearer(request.headers.get("Authorization"), env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  await ensure(env);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM tm_portal ORDER BY game_date, id").all();
    return Response.json(rows.results ?? [], { headers });
  }
  const body = (await request.json().catch(() => null)) as unknown;
  const items = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
  const now = new Date().toISOString();
  const stmts = [];
  for (const it of items) {
    const date = String(it?.game_date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "game_date YYYY-MM-DD required" }, { status: 400, headers });
    const readAt = it.read_at ? new Date(String(it.read_at)) : new Date();
    if (Number.isNaN(readAt.getTime())) return Response.json({ error: "bad read_at" }, { status: 400, headers });
    stmts.push(env.DB.prepare(
      `INSERT INTO tm_portal (game_date, event_id, read_at, suggested, range_low, range_high, sell_now, listed_price, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(date, it.event_id != null ? String(it.event_id) : null, readAt.toISOString(), num(it.suggested), num(it.range_low),
      num(it.range_high), num(it.sell_now), num(it.listed_price), it.status != null ? String(it.status) : null,
      it.note != null ? String(it.note) : null, now));
  }
  if (stmts.length) await env.DB.batch(stmts);
  const fresh = await latestTmReadsFromDb(env);
  if (fresh) await env.BOOK.put(CACHE_KEY, JSON.stringify(fresh));
  return Response.json({ ok: true, inserted: stmts.length }, { headers });
}
