/**
 * Ticketmaster pair comps on Cloudflare (no box needed).
 *
 * One cron ("0,30 14,15,21,22,23 * * *", UTC) covers both EDT and EST; the ET wall clock
 * picks the job: 10:00 and 17:00 full pulls (every unsold home game in the next 45 days),
 * 18:00 game-day pull (today's game only, skipped once it is within 15 min of tip), and
 * :30 sweeps that finish any attempt whose Apify webhook never arrived.
 *
 * The cron only starts Apify runs (apify/playwright-scraper, same input as the box scraper)
 * and returns. Apify calls /api/tm-comps/webhook when a run ends; that handler fetches the
 * run and its dataset from Apify (it never trusts the webhook body), validates, and either
 * writes rows to D1 tm_comps or starts the next attempt on a fresh session pool (max 3).
 *
 * Spend: before any start, the Apify account's monthly usage is checked. At the hard limit
 * the pull is logged as account_limit and nothing starts (no retries, no spend). Each
 * attempt reserves TM_ATTEMPT_RESERVE_USD until its measured cost is known; a pull stops
 * starting attempts at TM_MAX_USD_PER_PULL and the ET day at TM_MAX_USD_PER_ET_DAY.
 */
import eventsJson from "../data/tm-home-events.json";
import pageFunction from "./tm/page_function.js?raw";
import preNavHook from "./tm/pre_nav_hook.js?raw";
import {
  annotate,
  apifyRunCost,
  classify,
  etParts,
  eventsForPull,
  isAccountLimitError,
  isTarget,
  normalizeEvents,
  parseTmItems,
  pullKindAt,
  started,
  TM_COMPS_COLUMNS,
  TM_MAX_ATTEMPTS,
  TM_MIN_QTY,
  TM_SOURCE,
  tmCompsCsv,
  type PullKind,
  type TmCompRow,
  type TmEvent,
} from "./tm-spec";

export const TM_CRON = "0,30 14,15,21,22,23 * * *";
const API = "https://api.apify.com/v2";
export const TM_ACTOR = "apify~playwright-scraper";
// TM's public web-client key pair used by the event page itself for ismds calls (same as box).
const TM_API_KEY = "b462oi7fic6pehcdkzony5bxhe";
const TM_API_SECRET = "pquzpfrfz7zd2ylvtz3w5dtyse";
const RUN_MEMORY_MB = 2048;
const RUN_TIMEOUT_S = 300;
const STALE_MS = 12 * 60_000;

type TmEnv = Env & {
  TM_COMPS_ENABLED?: string;
  TM_WEBHOOK_BASE?: string;
  TM_MAX_USD_PER_PULL?: string;
  TM_MAX_USD_PER_ET_DAY?: string;
  TM_ATTEMPT_RESERVE_USD?: string;
  TM_MAX_CHARGE_USD_PER_RUN?: string;
  TM_DAYS_AHEAD?: string;
  TM_MAX_EVENTS_PER_PULL?: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Config = {
  enabled: boolean;
  webhookBase: string;
  maxPerPull: number;
  maxPerDay: number;
  reserve: number;
  maxChargePerRun: number;
  daysAhead: number;
  maxEvents: number;
};

function num(v: string | undefined, d: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d;
}

export function tmConfig(env: TmEnv): Config {
  return {
    enabled: (env.TM_COMPS_ENABLED ?? "false").trim().toLowerCase() === "true",
    webhookBase: (env.TM_WEBHOOK_BASE ?? "https://wizards-107p-cf.dfm7gb44c6.workers.dev").replace(/\/+$/, ""),
    // Hard ceilings in code: $1 per pull, $5 per ET day, whatever the vars say.
    maxPerPull: num(env.TM_MAX_USD_PER_PULL, 1, 1),
    maxPerDay: num(env.TM_MAX_USD_PER_ET_DAY, 3, 5),
    reserve: num(env.TM_ATTEMPT_RESERVE_USD, 0.08, 1),
    maxChargePerRun: num(env.TM_MAX_CHARGE_USD_PER_RUN, 0.4, 1),
    daysAhead: num(env.TM_DAYS_AHEAD, 45, 60),
    maxEvents: num(env.TM_MAX_EVENTS_PER_PULL, 20, 30),
  };
}

export const TM_EVENTS: TmEvent[] = normalizeEvents(eventsJson as never);

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(n = 10): string {
  return hex(crypto.getRandomValues(new Uint8Array(n))).slice(0, n * 2);
}

async function sign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

export function actorInput(ev: TmEvent, sessionTag: string): Record<string, unknown> {
  return {
    startUrls: [{ url: ev.url, userData: { eventId: ev.event_id, qty: TM_MIN_QTY, maxPages: 6, tmApiKey: TM_API_KEY, tmApiSecret: TM_API_SECRET } }],
    pageFunction,
    preNavigationHooks: preNavHook,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "US" },
    sessionPoolName: `tm_${sessionTag}`,
    launcher: "chromium", headless: true, useChrome: false,
    downloadMedia: false, downloadCss: false,
    ignoreSslErrors: false, maxRequestRetries: 1, maxPagesPerCrawl: 1,
    pageLoadTimeoutSecs: 60, pageFunctionTimeoutSecs: 120, waitUntil: "domcontentloaded",
    browserLog: false, closeCookieModals: true,
  };
}

// ---------- D1 ----------

type RunRow = {
  id: number; pull_id: string; kind: string; run_id: string; attempt: number;
  event_id: string | null; event_date: string | null; opponent: string | null; nonce: string | null;
  apify_run_id: string | null; dataset_id: string | null; status: string; raw_listings: number | null;
  cost_usd: number | null; reserved_usd: number; started_at: string;
};

async function insertRun(env: Env, r: Partial<RunRow> & { pull_id: string; kind: string; run_id: string; attempt: number; status: string; et_date: string; detail?: string; session_pool?: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tm_runs (pull_id, kind, run_id, attempt, event_id, event_date, opponent, nonce, session_pool, apify_run_id, dataset_id, status, detail, reserved_usd, et_date, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    r.pull_id, r.kind, r.run_id, r.attempt, r.event_id ?? null, r.event_date ?? null, r.opponent ?? null,
    r.nonce ?? null, r.session_pool ?? null, r.apify_run_id ?? null, r.dataset_id ?? null, r.status,
    r.detail ?? null, r.reserved_usd ?? 0, r.et_date, new Date().toISOString(),
    r.status === "running" ? null : new Date().toISOString(),
  ).run();
}

async function spentUsd(env: Env, where: string, arg: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN reserved_usd ELSE COALESCE(cost_usd, 0) END), 0) AS usd FROM tm_runs WHERE ${where} = ?`,
  ).bind(arg).first<{ usd: number }>();
  return Number(row?.usd ?? 0);
}

async function lastGoodRaw(env: Env, eventId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT raw_listings FROM tm_runs WHERE event_id = ? AND status = 'ok' AND raw_listings > 0 ORDER BY id DESC LIMIT 1`,
  ).bind(eventId).first<{ raw_listings: number }>();
  return row?.raw_listings ?? null;
}

/** All rows in one statement (json_each), so a big pull stays at one D1 query. */
export async function insertComps(env: Env, rows: TmCompRow[]): Promise<number> {
  if (!rows.length) return 0;
  const cols = TM_COMPS_COLUMNS;
  const payload = rows.map((r) => cols.map((c) => {
    const v = (r as Record<string, unknown>)[c];
    return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
  }));
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO tm_comps (${cols.join(", ")})
     SELECT ${cols.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?)`,
  ).bind(JSON.stringify(payload)).run();
  return Number((res as { meta?: { changes?: number } }).meta?.changes ?? rows.length);
}

// ---------- Apify ----------

type StartResult =
  | { ok: true; apifyRunId: string; datasetId: string | null }
  | { ok: false; accountLimit: boolean; detail: string };

type AccountCheck = { atLimit: boolean; detail: string };

export async function checkApifyAccount(token: string, f: FetchLike): Promise<AccountCheck> {
  const r = await f(`${API}/users/me/limits`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  if (!r.ok) {
    if (isAccountLimitError(r.status, text)) return { atLimit: true, detail: `limits HTTP ${r.status}` };
    return { atLimit: false, detail: `limits check HTTP ${r.status} (continuing)` };
  }
  try {
    const d = (JSON.parse(text) as { data?: { limits?: { maxMonthlyUsageUsd?: number }; current?: { monthlyUsageUsd?: number } } }).data;
    const max = Number(d?.limits?.maxMonthlyUsageUsd);
    const used = Number(d?.current?.monthlyUsageUsd);
    if (Number.isFinite(max) && Number.isFinite(used) && max > 0) {
      // Leave a little headroom: a run that starts right at the limit is refused anyway.
      if (used >= max - 0.05) return { atLimit: true, detail: `monthly usage $${used.toFixed(2)} of $${max.toFixed(2)} hard limit` };
      return { atLimit: false, detail: `monthly usage $${used.toFixed(2)} of $${max.toFixed(2)}` };
    }
  } catch {
    /* fall through */
  }
  return { atLimit: false, detail: "limits unknown" };
}

async function startRun(env: TmEnv, cfg: Config, ev: TmEvent, sessionTag: string, nonce: string, f: FetchLike): Promise<StartResult> {
  const sig = await sign(env.CRON_SECRET ?? "", nonce);
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: `${cfg.webhookBase}/api/tm-comps/webhook?n=${nonce}&s=${sig}`,
  }];
  const qs = new URLSearchParams({
    memory: String(RUN_MEMORY_MB),
    timeout: String(RUN_TIMEOUT_S),
    maxTotalChargeUsd: String(cfg.maxChargePerRun),
    webhooks: btoa(JSON.stringify(webhooks)),
  });
  const r = await f(`${API}/acts/${TM_ACTOR}/runs?${qs}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(actorInput(ev, sessionTag)),
  });
  const text = await r.text();
  if (!r.ok) {
    return { ok: false, accountLimit: isAccountLimitError(r.status, text), detail: `start HTTP ${r.status}: ${text.slice(0, 200)}` };
  }
  const data = (JSON.parse(text) as { data?: { id?: string; defaultDatasetId?: string } }).data;
  if (!data?.id) return { ok: false, accountLimit: false, detail: "start returned no run id" };
  return { ok: true, apifyRunId: data.id, datasetId: data.defaultDatasetId ?? null };
}

// ---------- pulls ----------

export type PullSummary = {
  kind: PullKind | "sweep" | "skip";
  pull_id?: string;
  status: string;
  detail?: string;
  started?: { event_date: string; run_id: string; apify_run_id: string }[];
  skipped?: { event_date: string; reason: string }[];
  finalized?: unknown[];
};

async function startAttempt(
  env: TmEnv, cfg: Config, f: FetchLike,
  a: { pull_id: string; kind: string; run_id: string; attempt: number; ev: TmEvent; etDate: string },
): Promise<{ ok: true; apifyRunId: string } | { ok: false; status: string; detail: string }> {
  const pullSpent = await spentUsd(env, "pull_id", a.pull_id);
  const daySpent = await spentUsd(env, "et_date", a.etDate);
  const base = { pull_id: a.pull_id, kind: a.kind, run_id: a.run_id, attempt: a.attempt, event_id: a.ev.event_id, event_date: a.ev.event_date, opponent: a.ev.opponent, et_date: a.etDate };
  if (pullSpent + cfg.reserve > cfg.maxPerPull + 1e-9 || daySpent + cfg.reserve > cfg.maxPerDay + 1e-9) {
    const detail = `budget stop: pull $${pullSpent.toFixed(3)}/$${cfg.maxPerPull}, day $${daySpent.toFixed(3)}/$${cfg.maxPerDay}`;
    await insertRun(env, { ...base, status: "budget_stop", detail });
    return { ok: false, status: "budget_stop", detail };
  }
  const session = randomId(5);
  const nonce = randomId(16);
  const res = await startRun(env, cfg, a.ev, session, nonce, f);
  if (!res.ok) {
    const status = res.accountLimit ? "account_limit" : "failed";
    await insertRun(env, { ...base, status, detail: res.detail, session_pool: `tm_${session}` });
    return { ok: false, status, detail: res.detail };
  }
  await insertRun(env, {
    ...base, status: "running", nonce, session_pool: `tm_${session}`, apify_run_id: res.apifyRunId,
    dataset_id: res.datasetId, reserved_usd: cfg.reserve,
  });
  return { ok: true, apifyRunId: res.apifyRunId };
}

export async function startPull(
  env: TmEnv, kind: PullKind, now: Date, f: FetchLike = fetch,
  opts: { events?: TmEvent[]; force?: boolean } = {},
): Promise<PullSummary> {
  const cfg = tmConfig(env);
  const et = etParts(now);
  const pull_id = `cf-${kind}-${et.iso.slice(0, 16).replace(/[-:]/g, "")}`;
  if (!cfg.enabled && !opts.force) return { kind, pull_id, status: "disabled" };
  if (!env.APIFY_TOKEN) return { kind, pull_id, status: "no_token" };
  const events = (opts.events ?? eventsForPull(TM_EVENTS, kind, now, cfg.daysAhead)).slice(0, cfg.maxEvents);
  if (!events.length) return { kind, pull_id, status: "no_events" };
  const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tm_runs WHERE pull_id = ?`).bind(pull_id).first<{ n: number }>();
  if (Number(existing?.n ?? 0) > 0 && !opts.force) return { kind, pull_id, status: "already_started" };

  const account = await checkApifyAccount(env.APIFY_TOKEN, f);
  if (account.atLimit) {
    // Quiet skip: one log row, no starts, no retries, no spend.
    await insertRun(env, { pull_id, kind, run_id: pull_id, attempt: 0, status: "account_limit", detail: account.detail, et_date: et.date });
    console.log(JSON.stringify({ tm_comps: "account_limit", pull_id, detail: account.detail }));
    return { kind, pull_id, status: "account_limit", detail: account.detail };
  }

  const startedRuns: NonNullable<PullSummary["started"]> = [];
  const skipped: NonNullable<PullSummary["skipped"]> = [];
  for (const ev of events) {
    const run_id = `${pull_id}-${ev.event_id.slice(-6)}`;
    const res = await startAttempt(env, cfg, f, { pull_id, kind, run_id, attempt: 1, ev, etDate: et.date });
    if (res.ok) {
      startedRuns.push({ event_date: ev.event_date, run_id, apify_run_id: res.apifyRunId });
    } else {
      skipped.push({ event_date: ev.event_date, reason: `${res.status}: ${res.detail}` });
      if (res.status === "account_limit" || res.status === "budget_stop") break;
    }
  }
  const status = startedRuns.length ? "started" : skipped[0]?.reason.split(":")[0] ?? "nothing_started";
  console.log(JSON.stringify({ tm_comps: status, pull_id, started: startedRuns.length, skipped: skipped.length, account: account.detail }));
  return { kind, pull_id, status, detail: account.detail, started: startedRuns, skipped };
}

// ---------- finalize (webhook or sweep) ----------

type ApifyRunInfo = { status?: string; defaultDatasetId?: string; startedAt?: string; finishedAt?: string; stats?: { runTimeSecs?: number } };

export async function finalizeAttempt(env: TmEnv, row: RunRow, f: FetchLike = fetch, now = new Date()): Promise<Record<string, unknown>> {
  const cfg = tmConfig(env);
  const h = { Authorization: `Bearer ${env.APIFY_TOKEN}` };
  const rr = await f(`${API}/actor-runs/${row.apify_run_id}`, { headers: h });
  if (!rr.ok) return { run_id: row.run_id, attempt: row.attempt, status: "pending", detail: `run HTTP ${rr.status}` };
  const run = ((await rr.json()) as { data?: ApifyRunInfo }).data ?? {};
  if (run.status === "READY" || run.status === "RUNNING") return { run_id: row.run_id, attempt: row.attempt, status: "pending" };
  const cost = apifyRunCost(run);
  const runtime = run.stats?.runTimeSecs ?? null;

  // Claim the row so a webhook retry and a sweep cannot both finish it.
  const claim = await env.DB.prepare(`UPDATE tm_runs SET status = 'finalizing' WHERE id = ? AND status = 'running'`).bind(row.id).run();
  if (Number((claim as { meta?: { changes?: number } }).meta?.changes ?? 1) === 0) return { run_id: row.run_id, attempt: row.attempt, status: "already_final" };

  const datasetId = run.defaultDatasetId ?? row.dataset_id;
  let items: unknown[] = [];
  if (datasetId) {
    const ir = await f(`${API}/datasets/${datasetId}/items?clean=true&format=json`, { headers: h });
    if (ir.ok) items = (await ir.json()) as unknown[];
  }
  const parsed = parseTmItems(Array.isArray(items) ? items : []);
  const prev = row.event_id ? await lastGoodRaw(env, row.event_id) : null;
  let { status, detail } = classify(parsed.listings.length, parsed.challenge, prev);
  detail = [`apify=${run.status}`, detail, parsed.notes].filter(Boolean).join("; ");
  const annotated = parsed.listings.map(annotate);
  const target = annotated.filter(isTarget);
  await env.DB.prepare(
    `UPDATE tm_runs SET status = ?, detail = ?, raw_listings = ?, target_rows = ?, runtime_s = ?, cost_usd = ?, dataset_id = ?, finished_at = ? WHERE id = ?`,
  ).bind(status, detail.slice(0, 500), parsed.listings.length, target.length, runtime, cost, datasetId ?? null, now.toISOString(), row.id).run();

  const ev = TM_EVENTS.find((e) => e.event_id === row.event_id) ?? {
    event_id: row.event_id ?? "", event_date: row.event_date ?? "", opponent: row.opponent ?? "", url: "", start_utc: null, soldOut: false,
  };
  const out: Record<string, unknown> = { run_id: row.run_id, attempt: row.attempt, status, raw: parsed.listings.length, target: target.length, cost_usd: cost, runtime_s: runtime };

  if (status === "ok") {
    out.written = await writeComps(env, ev, row, status, target, now);
    return out;
  }
  // Retry on a fresh session pool, unless out of attempts or the game is about to start.
  if (row.attempt < TM_MAX_ATTEMPTS && !started(ev, now) && ev.url) {
    const next = await startAttempt(env, cfg, f, { pull_id: row.pull_id, kind: row.kind, run_id: row.run_id, attempt: row.attempt + 1, ev, etDate: etParts(now).date });
    out.retry = next.ok ? { attempt: row.attempt + 1, apify_run_id: next.apifyRunId } : { status: next.status, detail: next.detail };
    if (next.ok) return out;
  }
  // Out of attempts: keep the best attempt (most listings), as the box scraper does.
  const best = await env.DB.prepare(
    `SELECT * FROM tm_runs WHERE run_id = ? AND raw_listings > 0 ORDER BY raw_listings DESC, attempt DESC LIMIT 1`,
  ).bind(row.run_id).first<RunRow & { status: string }>();
  if (best && best.raw_listings) {
    let rows = target;
    if (best.id !== row.id && best.dataset_id) {
      const br = await f(`${API}/datasets/${best.dataset_id}/items?clean=true&format=json`, { headers: h });
      const bItems = br.ok ? ((await br.json()) as unknown[]) : [];
      rows = parseTmItems(bItems).listings.map(annotate).filter(isTarget);
    }
    out.written = await writeComps(env, ev, best, best.status, rows, now);
    out.kept_attempt = best.attempt;
  }
  return out;
}

async function writeComps(env: Env, ev: TmEvent, row: { run_id: string; attempt: number }, status: string, target: ReturnType<typeof annotate>[], now: Date): Promise<number> {
  const captured = etParts(now).iso;
  const rows: TmCompRow[] = target
    .map((r) => ({
      ...r, captured_at_et: captured, run_id: row.run_id, attempt: row.attempt, run_status: status,
      event_id: ev.event_id, event_date: ev.event_date, opponent: ev.opponent, source: TM_SOURCE,
    }))
    .sort((a, b) => (a.price_per_ticket_all_in ?? Infinity) - (b.price_per_ticket_all_in ?? Infinity));
  return insertComps(env, rows);
}

export async function sweepPending(env: TmEnv, f: FetchLike = fetch, now = new Date()): Promise<unknown[]> {
  if (!env.APIFY_TOKEN) return [];
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT * FROM tm_runs WHERE status = 'running' AND started_at < ? ORDER BY id LIMIT 10`,
  ).bind(cutoff).all<RunRow>();
  const out = [];
  for (const row of rows.results ?? []) out.push(await finalizeAttempt(env, row, f, now));
  // A claim that crashed mid-way: give it back to the next sweep.
  await env.DB.prepare(`UPDATE tm_runs SET status = 'running' WHERE status = 'finalizing' AND started_at < ?`)
    .bind(new Date(now.getTime() - 3 * STALE_MS).toISOString()).run();
  return out;
}

/** Cron entry: decide by ET clock what this tick is. */
export async function runTmCron(env: TmEnv, scheduledTime: Date, f: FetchLike = fetch): Promise<PullSummary> {
  const kind = pullKindAt(scheduledTime);
  if (!tmConfig(env).enabled) return { kind: kind ?? "skip", status: "disabled" };
  if (kind === "sweep") return { kind, status: "swept", finalized: await sweepPending(env, f, scheduledTime) };
  if (!kind) return { kind: "skip", status: "not_a_pull_hour" };
  const summary = await startPull(env, kind, scheduledTime, f);
  // Each pull tick also clears anything stale from earlier pulls.
  summary.finalized = await sweepPending(env, f, scheduledTime);
  return summary;
}

// ---------- HTTP ----------

export async function tmWebhookResponse(request: Request, env: TmEnv, f: FetchLike = fetch): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("n") ?? "";
  const sig = url.searchParams.get("s") ?? "";
  if (!env.CRON_SECRET || !/^[0-9a-f]{32}$/.test(nonce)) return new Response(null, { status: 401 });
  const want = await sign(env.CRON_SECRET, nonce);
  if (want.length !== sig.length || !timingSafe(want, sig)) return new Response(null, { status: 401 });
  const row = await env.DB.prepare(`SELECT * FROM tm_runs WHERE nonce = ?`).bind(nonce).first<RunRow>();
  if (!row) return Response.json({ status: "unknown" }, { status: 404 });
  if (row.status !== "running") return Response.json({ status: "already_final" });
  return Response.json(await finalizeAttempt(env, row, f));
}

function timingSafe(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Admin CSV: /api/admin/tm-comps.csv?event=YYYY-MM-DD|<TM id>&since=<ISO or YYYY-MM-DD>&limit=N */
export async function tmCompsCsvResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const where: string[] = [];
  const args: unknown[] = [];
  const event = url.searchParams.get("event");
  if (event) {
    where.push(/^\d{4}-\d{2}-\d{2}$/.test(event) ? "event_date = ?" : "event_id = ?");
    args.push(event);
  }
  const since = url.searchParams.get("since");
  if (since) {
    where.push("captured_at_et > ?");
    args.push(since);
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20000, 1), 50000);
  const rows = await env.DB.prepare(
    `SELECT ${TM_COMPS_COLUMNS.join(", ")} FROM tm_comps ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY captured_at_et, event_date, price_per_ticket_all_in LIMIT ${limit}`,
  ).bind(...args).all<Record<string, unknown>>();
  return new Response(tmCompsCsv(rows.results ?? []), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tm_comps${event ? `-${event}` : ""}.csv"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/** Admin JSON: latest capture per event (cheapest 5 pairs near 107) plus the last 30 attempts. */
export async function tmCompsStatusResponse(env: TmEnv): Promise<Response> {
  const cfg = tmConfig(env);
  const runs = await env.DB.prepare(
    `SELECT pull_id, kind, run_id, attempt, event_date, opponent, apify_run_id, status, detail, raw_listings, target_rows, runtime_s, cost_usd, started_at, finished_at FROM tm_runs ORDER BY id DESC LIMIT 30`,
  ).all();
  const latest = await env.DB.prepare(
    `SELECT c.event_date, c.opponent, c.captured_at_et, c.section, c.row, c.seats, c.qty_available, c.price_per_ticket_listed, c.price_per_ticket_all_in, c.listing_type, c.side_of_arena
       FROM tm_comps c
       JOIN (SELECT event_id, MAX(captured_at_et) AS m FROM tm_comps GROUP BY event_id) l ON l.event_id = c.event_id AND l.m = c.captured_at_et
      WHERE c.near_107 = 1
      ORDER BY c.event_date, c.price_per_ticket_all_in LIMIT 200`,
  ).all<Record<string, unknown>>();
  const byEvent: Record<string, unknown[]> = {};
  for (const r of latest.results ?? []) {
    const k = String(r.event_date);
    const list = (byEvent[k] ??= []);
    if (list.length < 5) list.push(r);
  }
  const today = etParts(new Date()).date;
  return Response.json(
    {
      enabled: cfg.enabled,
      cron_utc: TM_CRON,
      schedule_et: "10:00 and 17:00 full pulls (next 45 days), 18:00 game-day pull, :30 sweeps",
      caps: { per_pull_usd: cfg.maxPerPull, per_et_day_usd: cfg.maxPerDay, attempt_reserve_usd: cfg.reserve, max_charge_per_run_usd: cfg.maxChargePerRun },
      spent_today_usd: await spentUsd(env, "et_date", today),
      cheapest_near_107_latest: byEvent,
      runs: runs.results ?? [],
    },
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } },
  );
}
