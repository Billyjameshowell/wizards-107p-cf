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

/** Newest read per game. */
export async function latestTmReads(env: Env): Promise<Record<string, TmPortalRead>> {
  try {
    await ensure(env);
    const rows = await env.DB.prepare(
      `SELECT t.* FROM tm_portal t JOIN (SELECT game_date, MAX(id) id FROM tm_portal GROUP BY game_date) m ON m.id = t.id`,
    ).all<TmPortalRead & { game_date: string }>();
    const out: Record<string, TmPortalRead> = {};
    for (const r of rows.results ?? []) {
      out[r.game_date] = {
        read_at: r.read_at, event_id: r.event_id, suggested: r.suggested, range_low: r.range_low,
        range_high: r.range_high, sell_now: r.sell_now, listed_price: r.listed_price, status: r.status, note: r.note,
      };
    }
    return out;
  } catch (error) {
    console.error("tm_portal", error);
    return {};
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
  return Response.json({ ok: true, inserted: stmts.length }, { headers });
}
