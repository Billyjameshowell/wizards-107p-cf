import { authorizeBearer } from "../src/shared/guardrails";
import { etYmd } from "../src/shared/pricing";
import { loadLiveBook } from "./store";

/** A lookup that may fail without blocking the sale record; the failure is still logged. */
function logged(what: string) {
  return (error: unknown): null => {
    console.error(what, error);
    return null;
  };
}

const DDL = `CREATE TABLE IF NOT EXISTS sale_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE, game_date TEXT NOT NULL, event_id TEXT,
  sold_at TEXT NOT NULL, seats_sold INTEGER, sold_price_per_seat REAL, payout_per_seat REAL, payout_total REAL,
  model_ask_at_sale REAL, tm_suggested_at_sale REAL, days_before_game INTEGER, source TEXT NOT NULL, note TEXT,
  created_at TEXT NOT NULL)`;

export type SaleInput = {
  external_id?: string;
  game_date: string;
  event_id?: string | null;
  sold_at: string;
  seats_sold?: number | null;
  sold_price_per_seat?: number | null;
  payout_per_seat?: number | null;
  payout_total?: number | null;
  source?: string;
  note?: string | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

async function ensure(env: Env): Promise<void> {
  await env.DB.prepare(DDL).run();
}

/** Insert one sale, snapshotting the model ask and TM suggested as of sold_at. Duplicate external_id is ignored. */
export async function recordSale(env: Env, input: SaleInput): Promise<boolean> {
  await ensure(env);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.game_date)) throw new Error("game_date YYYY-MM-DD required");
  const soldAt = new Date(input.sold_at);
  if (Number.isNaN(soldAt.getTime())) throw new Error("bad sold_at");
  const iso = soldAt.toISOString();
  const ask = await env.DB.prepare(
    // Newest ask for an ET day on or before the sale day (recomputed rows were saved later but fit only that day's comps).
    `SELECT ask FROM suggested_asks WHERE game_date = ? AND et_date <= ? ORDER BY et_date DESC, id DESC LIMIT 1`,
  ).bind(input.game_date, etYmd(soldAt)).first<{ ask: number }>().catch(logged("sale: model ask lookup"));
  const tm = await env.DB.prepare(
    `SELECT suggested, event_id FROM tm_portal WHERE game_date = ? AND read_at <= ? AND suggested IS NOT NULL ORDER BY read_at DESC, id DESC LIMIT 1`,
  ).bind(input.game_date, iso).first<{ suggested: number; event_id: string | null }>().catch(logged("sale: TM suggestion lookup"));
  const days = Math.round((Date.parse(`${input.game_date}T00:00:00Z`) - Date.parse(`${etYmd(soldAt)}T00:00:00Z`)) / 86400000);
  const seats = num(input.seats_sold);
  const perSeatPayout = num(input.payout_per_seat) ?? (num(input.payout_total) != null && seats ? num(input.payout_total)! / seats : null);
  const r = await env.DB.prepare(
    `INSERT INTO sale_outcomes (external_id, game_date, event_id, sold_at, seats_sold, sold_price_per_seat, payout_per_seat,
      payout_total, model_ask_at_sale, tm_suggested_at_sale, days_before_game, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(external_id) DO NOTHING`,
  ).bind(
    input.external_id ?? `sale:${input.game_date}:${iso}`, input.game_date, input.event_id ?? tm?.event_id ?? null, iso,
    seats, num(input.sold_price_per_seat), perSeatPayout, num(input.payout_total), ask?.ask ?? null, tm?.suggested ?? null,
    days, input.source ?? "manual", input.note ?? null, new Date().toISOString(),
  ).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Any game the book marks sold (Gmail sync / 107P alerts write the book) gets a row once.
 * Keyed by the TM order number, so it never duplicates a manual or backfilled row for the same order.
 */
export async function syncSalesFromBook(env: Env): Promise<number> {
  await ensure(env);
  const book = await loadLiveBook(env);
  let added = 0;
  for (const g of book.games) {
    if (!g.sold || !g.sold_at) continue;
    const id = g.sold_order ? `order:${g.sold_order}` : `book:${g.date}`;
    const keep = typeof g.sold_keep_total === "number" ? g.sold_keep_total : null;
    const ok = await recordSale(env, {
      external_id: id, game_date: g.date, sold_at: g.sold_at, seats_sold: book.seats?.length ?? 2,
      sold_price_per_seat: g.listed_ask, payout_total: keep, source: "gmail",
      note: g.sold_order ? `TM order ${g.sold_order}` : null,
    });
    if (ok) added += 1;
  }
  return added;
}

export async function listSales(env: Env): Promise<Record<string, unknown>[]> {
  await ensure(env);
  return (await env.DB.prepare("SELECT * FROM sale_outcomes ORDER BY sold_at").all()).results ?? [];
}

/** GET lists, POST appends (one object or an array). Bearer CRON_SECRET. */
export async function salesResponse(request: Request, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!authorizeBearer(request.headers.get("Authorization"), env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  if (request.method === "GET") return Response.json(await listSales(env), { headers });
  const body = (await request.json().catch(() => null)) as unknown;
  const items = (Array.isArray(body) ? body : [body]) as SaleInput[];
  let inserted = 0;
  try {
    // Sale-marking path: also pick up any sale the book (Gmail sync) has marked.
    if (items.length === 1 && (items[0] as unknown as { sync?: boolean })?.sync === true) {
      return Response.json({ ok: true, inserted: await syncSalesFromBook(env) }, { headers });
    }
    for (const it of items) if (await recordSale(env, { ...it, source: it?.source ?? "manual" })) inserted += 1;
  } catch (error) {
    return Response.json({ error: String((error as Error).message) }, { status: 400, headers });
  }
  return Response.json({ ok: true, inserted }, { headers });
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function salesAdminSection(env: Env): Promise<string> {
  try {
    const rows = await listSales(env);
    const body = rows.map((r) => `<tr>${["game_date", "sold_at", "seats_sold", "sold_price_per_seat", "payout_total", "model_ask_at_sale", "tm_suggested_at_sale", "days_before_game", "source", "note"].map((k) => `<td>${esc(r[k])}</td>`).join("")}</tr>`).join("");
    return `<h2>Sale outcomes</h2><table><thead><tr><th>Game</th><th>Sold at (UTC)</th><th>Seats</th><th>Price/seat</th><th>Payout</th><th>Model ask</th><th>TM sugg</th><th>Days out</th><th>Source</th><th>Note</th></tr></thead><tbody>${body || '<tr><td colspan="10">None yet</td></tr>'}</tbody></table>`;
  } catch (error) {
    console.error("sales admin", error);
    return "";
  }
}
