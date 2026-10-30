/**
 * Ticketmaster lower-bowl pair comps: the parsing and tagging rules, shared by the Worker
 * cron (worker/tm-comps.ts) and kept identical to the box scraper
 * (/workspace/wizards-tickets/tm-scrape/scrape_tm.py, Billy's spec of 2026-10-30).
 * Pure functions only, so tests run them without D1 or Apify.
 */

export const TM_SECTIONS = Array.from({ length: 28 }, (_, i) => String(100 + i)); // 100-127
export const TM_ROWS = ["N", "O", "P", "Q", "R", "S", "T"];
export const TM_MIN_QTY = 2;
export const TM_NEAR_107 = new Set(["105", "106", "107", "108", "109", "117", "118", "119", "120", "121"]);
export const TM_PARTIAL_RATIO = 0.5;
export const TM_MAX_ATTEMPTS = 3;
export const TM_SOURCE = "ticketmaster_quickpicks_via_apify";

// Capital One Arena, Wizards layout: Wizards bench in front of 101, visitor bench in front of 121.
const SIDE: Record<string, string> = {};
for (const s of ["121", "100", "101"]) SIDE[s] = "bench_sideline_center";
for (const s of ["102", "103"]) SIDE[s] = "bench_side_corner_107_end";
for (const s of ["119", "120"]) SIDE[s] = "bench_side_corner_opposite_end";
for (const s of ["110", "111", "112"]) SIDE[s] = "far_sideline_center";
for (const s of ["108", "109"]) SIDE[s] = "far_side_corner_107_end";
for (const s of ["113", "114"]) SIDE[s] = "far_side_corner_opposite_end";
for (const s of ["104", "105", "106", "107"]) SIDE[s] = "baseline_107_end";
for (const s of ["115", "116", "117", "118"]) SIDE[s] = "opposite_baseline";
export const TM_SIDE_OF_ARENA: Readonly<Record<string, string>> = SIDE;

/** Fixed column order, the same as tm-scrape/data/tm_comps.csv. */
export const TM_COMPS_COLUMNS = [
  "captured_at_et", "run_id", "attempt", "run_status", "event_id", "event_date", "opponent",
  "section", "row", "seats", "qty_available", "price_per_ticket_listed", "price_per_ticket_all_in",
  "fees_included", "listing_type", "listing_id", "is_lower_bowl", "in_target_rows", "is_pair",
  "near_107", "side_of_arena", "source",
] as const;

export type TmListing = {
  section: string;
  row: string;
  seats: string;
  qty_available: number | null;
  sellable: number[];
  price_per_ticket_listed: number | null;
  price_per_ticket_all_in: number | null;
  fees_included: boolean;
  listing_type: "resale" | "standard";
  listing_id: string;
};

export type TmAnnotated = TmListing & {
  is_lower_bowl: boolean;
  in_target_rows: boolean;
  is_pair: boolean;
  near_107: boolean;
  side_of_arena: string;
};

export type TmCompRow = TmAnnotated & {
  captured_at_et: string;
  run_id: string;
  attempt: number;
  run_status: string;
  event_id: string;
  event_date: string;
  opponent: string;
  source: string;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function money(v: unknown): number | null {
  let x = v;
  const o = obj(x);
  if (o) x = o.total ?? o.value ?? o.amount;
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function seatSort(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** TM ismds quickpicks JSON -> one listing per pick (same rules as parse_quickpicks in scrape_tm.py). */
export function parseQuickpicks(qp: unknown): TmListing[] {
  const root = obj(qp);
  if (!root) return [];
  const offers = new Map<string, Obj>();
  for (const o of arr(obj(root._embedded)?.offer)) {
    const offer = obj(o);
    if (offer && offer.offerId != null) offers.set(String(offer.offerId), offer);
  }
  const out: TmListing[] = [];
  for (const raw of arr(root.picks)) {
    const p = obj(raw);
    if (!p) continue;
    const sec = String(p.section ?? p.sectionName ?? "").trim();
    const row = String(p.row ?? "").trim();
    let oids = arr(p.offers).map(String);
    let seats: string[] = [];
    for (const g of arr(p.offerGroups)) {
      const group = obj(g);
      oids = oids.concat(arr(group?.offers).map(String));
      seats = seats.concat(arr(group?.seats).map(String));
    }
    seats = seats.concat(arr(p.seats ?? p.seatNumbers).map(String));
    oids = [...new Set(oids)];
    const id = oids.find((i) => offers.has(i));
    if (id == null) continue;
    const o = offers.get(id)!;
    const listed = money(o.listPrice ?? o.faceValue);
    let allIn = money(o.totalPrice);
    if (allIn == null && listed != null) {
      const fees = arr(o.charges).reduce<number>((s, c) => s + (money(obj(c)?.amount) ?? 0), 0);
      allIn = fees ? Math.round((listed + fees) * 100) / 100 : null;
    }
    const inv = String(o.inventoryType ?? p.type ?? "").toLowerCase();
    const sellable = arr(o.sellableQuantities).map(Number).filter(Number.isFinite);
    const uniqSeats = [...new Set(seats)].sort(seatSort);
    const maxQ = Number(p.maxQuantity);
    const qty = (Number.isFinite(maxQ) && maxQ > 0 ? maxQ : null) ?? (sellable.length ? Math.max(...sellable) : null) ?? (uniqSeats.length || null);
    out.push({
      section: sec,
      row,
      seats: uniqSeats.join("-"),
      qty_available: qty,
      sellable,
      price_per_ticket_listed: listed,
      price_per_ticket_all_in: allIn,
      fees_included: allIn != null,
      listing_type: inv.includes("resale") ? "resale" : "standard",
      listing_id: String(o.listingId ?? o.offerId ?? ""),
    });
  }
  return out;
}

/** Dataset items from page_function.js -> deduped listings, challenge flag, notes. */
export function parseTmItems(items: unknown[]): { listings: TmListing[]; challenge: boolean; notes: string } {
  const raw: TmListing[] = [];
  let challenge = false;
  const notes: string[] = [];
  for (const x of items) {
    const it = obj(x);
    if (!it) continue;
    if (it.challenge) challenge = true;
    for (const pg of arr(it.quickpicks)) {
      const j = obj(pg)?.json;
      if (obj(j)) raw.push(...parseQuickpicks(j));
    }
    for (const c of arr(it.captured)) {
      const cap = obj(c);
      if (String(cap?.url ?? "").includes("quickpicks") && obj(cap?.json)) raw.push(...parseQuickpicks(cap!.json));
    }
    const errors = arr(it.errors);
    if (errors.length) notes.push(`api_errors=${JSON.stringify(errors[0]).slice(0, 200)}`);
  }
  const seen = new Set<string>();
  const listings = raw.filter((r) => {
    const k = [r.listing_id, r.section, r.row, r.seats, r.price_per_ticket_listed].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { listings, challenge, notes: notes.join("; ") };
}

export function annotate(r: TmListing): TmAnnotated {
  const sec = /^\D*\d{3}\D*$/.test(r.section) ? r.section.replace(/\D/g, "") : r.section;
  const row = r.row.toUpperCase();
  const qtyOk = (r.qty_available ?? 0) >= TM_MIN_QTY && (!r.sellable.length || r.sellable.some((q) => q >= TM_MIN_QTY));
  const lower = TM_SECTIONS.includes(sec);
  return {
    ...r,
    section: sec,
    row,
    is_lower_bowl: lower,
    in_target_rows: TM_ROWS.includes(row),
    is_pair: qtyOk,
    near_107: TM_NEAR_107.has(sec),
    side_of_arena: TM_SIDE_OF_ARENA[sec] ?? (lower ? "unmapped" : ""),
  };
}

export const isTarget = (r: TmAnnotated): boolean => r.is_lower_bowl && r.in_target_rows && r.is_pair;

export type TmStatus = "ok" | "partial" | "blocked";

export function classify(nRaw: number, challenge: boolean, prevGood: number | null): { status: TmStatus; detail: string } {
  if (challenge && nRaw === 0) return { status: "blocked", detail: "challenge page" };
  if (nRaw === 0) return { status: "blocked", detail: "0 listings" };
  if (prevGood && nRaw < TM_PARTIAL_RATIO * prevGood) {
    return { status: "partial", detail: `${nRaw} < ${TM_PARTIAL_RATIO * 100}% of last good ${prevGood}` };
  }
  return { status: "ok", detail: "" };
}

/** Apify run cost: platform usage plus any pay-per-event charges (run_cost in scrape_tm.py). */
export function apifyRunCost(run: unknown): number {
  const r = obj(run) ?? {};
  let cost = Number(r.usageTotalUsd ?? 0) || 0;
  const events = obj(obj(obj(r.pricingInfo)?.pricingPerEvent)?.actorChargeEvents) ?? {};
  for (const [name, n] of Object.entries(obj(r.chargedEventCounts) ?? {})) {
    cost += (Number(obj(events[name])?.eventPriceUsd ?? 0) || 0) * (Number(n) || 0);
  }
  return Math.round(cost * 1e5) / 1e5;
}

/** Monthly-usage hard limit, either from the start call's error or the limits endpoint. */
export function isAccountLimitError(status: number, body: string): boolean {
  return (status === 402 || status === 403 || status === 429) &&
    /hard limit|platform-feature-disabled|monthly usage|usage limit|exceeded/i.test(body);
}

// ---------- time (America/New_York) ----------

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", timeZoneName: "longOffset",
});

export function etParts(d: Date): { date: string; hour: number; minute: number; iso: string } {
  const p: Record<string, string> = {};
  for (const x of ET_PARTS.formatToParts(d)) p[x.type] = x.value;
  const offset = (p.timeZoneName ?? "GMT-05:00").replace("GMT", "") || "+00:00";
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    hour: Number(p.hour),
    minute: Number(p.minute),
    iso: `${date}T${p.hour}:${p.minute}:${p.second}${offset}`,
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- events ----------

export type TmEvent = { event_id: string; event_date: string; url: string; start_utc: string | null; opponent: string; soldOut: boolean };

export function normalizeEvents(raw: { id: string; title: string; url: string; start?: string | null; local_date?: string | null; soldOut?: boolean }[]): TmEvent[] {
  return raw
    .filter((e) => e.local_date && !/preseason/i.test(e.title))
    .map((e) => {
      const m = /vs\.?\s+(.+)$/.exec(e.title);
      return {
        event_id: e.id,
        event_date: e.local_date as string,
        url: e.url,
        start_utc: e.start ?? null,
        opponent: (m ? m[1] : e.title).trim(),
        soldOut: Boolean(e.soldOut),
      };
    })
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
}

/** Tip-off within 15 minutes (or past) counts as started. */
export function started(e: TmEvent, now: Date): boolean {
  if (!e.start_utc) return false;
  return now.getTime() > new Date(e.start_utc).getTime() - 15 * 60_000;
}

export type PullKind = "full" | "gameday";

/** Which pull (if any) a TM cron tick is, by ET wall clock: 10:00 and 17:00 full, 18:00 game day. */
export function pullKindAt(now: Date): PullKind | "sweep" | null {
  const { hour, minute } = etParts(now);
  if (minute >= 25 && minute < 35) return "sweep";
  if (minute > 5) return null;
  if (hour === 10 || hour === 17) return "full";
  if (hour === 18) return "gameday";
  return null;
}

export function eventsForPull(events: TmEvent[], kind: PullKind, now: Date, daysAhead = 45): TmEvent[] {
  const today = etParts(now).date;
  if (kind === "gameday") return events.filter((e) => e.event_date === today && !started(e, now));
  const horizon = addDays(today, daysAhead);
  return events.filter((e) => e.event_date >= today && e.event_date <= horizon && !e.soldOut && !started(e, now));
}

// ---------- CSV ----------

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "boolean" ? (v ? "True" : "False") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const BOOL_COLS = new Set(["fees_included", "is_lower_bowl", "in_target_rows", "is_pair", "near_107"]);

/** CSV in the box file's format (Python csv: booleans as True/False). */
export function tmCompsCsv(rows: Record<string, unknown>[]): string {
  const lines = [TM_COMPS_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(TM_COMPS_COLUMNS.map((c) => csvCell(BOOL_COLS.has(c) && r[c] != null ? Boolean(r[c]) : r[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
