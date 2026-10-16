import { freshness } from "../src/shared/freshness";
import { bookPullInstants, ingestStatusWarnings, latestInstant } from "../src/shared/ingest-status";
import { formatEtStamp } from "../src/shared/book";
import { authorizeBearer, parseFlags, timingSafeEqual } from "../src/shared/guardrails";
import { ensureArchive } from "./archive-store";
import { latestSavedModel, prepareModelFit } from "./model-fit";
import { readBook } from "./store";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

function modelErrorText(
  model:
    | {
        fittedAt: string | null;
        rows: number | null;
        early: boolean | null;
        holdoutMedianAbsPercent: number | null;
      }
    | null
    | undefined,
): string {
  if (!model) return "No saved fit yet. The next morning check will store one.";
  const miss =
    model.holdoutMedianAbsPercent == null
      ? "not enough checks to score the next price yet"
      : `${model.holdoutMedianAbsPercent}% median miss on the next price check`;
  const rows = model.rows == null ? "unknown" : String(model.rows);
  const stage = model.early ? "early estimate" : "past the early-data bar";
  const saved = model.fittedAt ? ` Saved ${formatEtStamp(new Date(model.fittedAt))} ET.` : "";
  return escapeHtml(`${miss}. ${rows} cleaned checks. ${stage}.${saved}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Bearer CRON_SECRET, or HTTP Basic with that secret as the password. */
export function authorizeAdmin(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.trim() === "") return false;
  if (authorizeBearer(header, secret)) return true;
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return timingSafeEqual(decoded.slice(separator + 1), secret);
}

export function renderAdminStatusPage(args: {
  warnings: readonly string[];
  ingestEnabled: boolean;
  dryRun: boolean;
  lastPullAt: string | null;
  lastAttemptAt?: string | null;
  seatdataKey: boolean;
  apifyToken: boolean;
  offerSaved?: boolean;
  games?: readonly { date: string; opponent: string }[];
  offers?: readonly { gameDate: string; total: number; perTicket: number; observedAt: string; note: string | null }[];
  /** Newest data per source, for the freshness pills. */
  sources?: readonly { label: string; at: string | null }[];
  now?: Date;
  model?: {
    fittedAt: string | null;
    rows: number | null;
    early: boolean | null;
    holdoutMedianAbsPercent: number | null;
  } | null;
}): string {
  const last = args.lastPullAt ? formatEtStamp(new Date(args.lastPullAt)) : "none";
  const attempt = args.lastAttemptAt ? formatEtStamp(new Date(args.lastAttemptAt)) : "none";
  const banners = args.warnings
    .map((warning) => `<p class="warn" role="alert">${escapeHtml(warning)}</p>`)
    .join("");
  const pills = (args.sources ?? [])
    .map((source) => {
      const f = freshness(source.at, args.now);
      return `<span class="pill ${f.tone}"><i></i>${escapeHtml(source.label)} · ${escapeHtml(f.label)}</span>`;
    })
    .join("");
  const games = args.games ?? [];
  const options = games
    .map(
      (game) =>
        `<option value="${escapeHtml(game.date)}">${escapeHtml(game.date)} ${escapeHtml(game.opponent)}</option>`,
    )
    .join("");
  const saved = args.offerSaved ? `<p class="saved">Instant offer saved. Nothing was listed.</p>` : "";
  const logged = (args.offers ?? [])
    .slice()
    .reverse()
    .slice(0, 12)
    .map(
      (offer) =>
        `<li>${escapeHtml(offer.gameDate)}: ${escapeHtml(offer.total.toFixed(2))} for the pair (${escapeHtml(offer.perTicket.toFixed(2))} a seat)${offer.note ? `, ${escapeHtml(offer.note)}` : ""}</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex,nofollow">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Wizards 107P admin status</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; margin: 24px auto; max-width: 38rem; color: #142033; }
    a { color: #0c2340; }
    .warn { background: #fff4d6; border: 1px solid #8a4b00; border-radius: 8px; padding: 12px 14px; margin: 0 0 12px; }
    dt { font-weight: 650; }
    dd { margin: 0 0 8px; }
    form { display: grid; gap: 10px; margin-top: 8px; }
    label { display: grid; gap: 4px; font-weight: 650; }
    input, select { font: inherit; padding: 8px; }
    button { font: inherit; padding: 8px 12px; }
    .saved { background: #e7f6ea; border: 1px solid #1f5c32; border-radius: 8px; padding: 12px 14px; }
    body { padding: 0 16px; }
    h1 { margin: 4px 0 8px; font-size: 1.6rem; }
    h2 { margin-top: 28px; font-size: 1.15rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
    dd { margin: 0; }
    .muted { font-weight: 400; color: #445; }
    .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
    .pill i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    .fresh { background: #ecfdf5; border-color: #6ee7b7; color: #065f46; } .fresh i { background: #10b981; }
    .aging { background: #fffbeb; border-color: #fcd34d; color: #92400e; } .aging i { background: #f59e0b; }
    .stale { background: #fef2f2; border-color: #fca5a5; color: #991b1b; } .stale i { background: #ef4444; }
    input, select, button { min-height: 44px; border-radius: 8px; border: 1px solid #c9c3b6; }
    button { background: #0c2340; color: #fff; border: 0; font-weight: 650; }
    @media (max-width: 480px) { dl { grid-template-columns: 1fr; gap: 0; } dd { margin-bottom: 8px; } }
  </style>
</head>
<body>
  <p><a href="/">Ticket book</a></p>
  <h1>Admin status</h1>
  ${pills ? `<div class="pills" aria-label="Data freshness">${pills}</div>` : ""}
  ${banners}
  <dl>
    <dt>Ingest</dt><dd>${args.ingestEnabled ? "on" : "off"}</dd>
    <dt>Dry run</dt><dd>${args.dryRun ? "on" : "off"}</dd>
    <dt>Last successful pull</dt><dd>${escapeHtml(last)} ET <span class="muted">(home-game prices landed)</span></dd>
    <dt>Last attempt</dt><dd>${escapeHtml(attempt)} ET <span class="muted">(any SeatData or Apify run)</span></dd>
    <dt>SeatData key</dt><dd>${args.seatdataKey ? "set" : "missing"}</dd>
    <dt>Apify token</dt><dd>${args.apifyToken ? "set" : "missing"}</dd>
    <dt>Caps</dt><dd>SeatData 20/run, 25/day · Apify $0.50, 50 events</dd>
    <dt>Next-check error</dt><dd>${modelErrorText(args.model)}</dd>
  </dl>
  <h2>Instant offer</h2>
  ${saved}
  <p>Log a sell-now offer, e.g. Get Paid $26.60 ($13.30 per ticket). Pair total, per ticket, or both. Nothing gets listed.</p>
  <form method="post" action="/admin/instant-offer">
    <label>Game
      ${
        options
          ? `<select name="game" required>${options}</select>`
          : `<input name="game" required pattern="\\d{4}-\\d{2}-\\d{2}" placeholder="2026-11-15">`
      }
    </label>
    <label>Get paid, both tickets <input name="offered_total" inputmode="decimal" placeholder="26.60"></label>
    <label>Per ticket <input name="per_ticket" inputmode="decimal" placeholder="13.30"></label>
    <label>Note <input name="note" maxlength="200"></label>
    <button type="submit">Save instant offer</button>
  </form>
  ${logged ? `<ul>${logged}</ul>` : ""}
</body>
</html>`;
}

/** A pull that actually returned home-game prices (not just an ok archive shell). */
export function isPricedHomePull(row: {
  game_date: string | null;
  status: string;
  listing_count: number | null;
  median: number | null;
  get_in: number | null;
}): boolean {
  if (row.status !== "ok" || !row.game_date) return false;
  if (row.listing_count != null && row.listing_count > 0) return true;
  if (row.median != null && Number.isFinite(row.median)) return true;
  if (row.get_in != null && Number.isFinite(row.get_in)) return true;
  return false;
}

async function latestSuccessfulLivePull(env: Env): Promise<string | null> {
  try {
    await ensureArchive(env);
    const row = await env.DB.prepare(
      `SELECT MAX(pulled_at) AS pulled_at FROM price_pulls
       WHERE source IN ('seatdata', 'apify')
         AND trigger_name IN ('cron', 'http')
         AND status = 'ok'
         AND game_date IS NOT NULL
         AND (
           COALESCE(listing_count, 0) > 0
           OR median IS NOT NULL
           OR get_in IS NOT NULL
         )`,
    ).first<{ pulled_at: string | null }>();
    return row?.pulled_at ?? null;
  } catch (error) {
    console.error("admin last pull", error);
    return null;
  }
}

async function latestLiveAttempt(env: Env): Promise<string | null> {
  try {
    await ensureArchive(env);
    const row = await env.DB.prepare(
      `SELECT MAX(pulled_at) AS pulled_at FROM price_pulls
       WHERE source IN ('seatdata', 'apify')
         AND trigger_name IN ('cron', 'http')`,
    ).first<{ pulled_at: string | null }>();
    return row?.pulled_at ?? null;
  } catch (error) {
    console.error("admin last attempt", error);
    return null;
  }
}

/** Newest priced home-game pull per source. */
async function sourceFreshness(env: Env): Promise<Record<string, string | null>> {
  try {
    const rows = await env.DB.prepare(
      `SELECT source, MAX(pulled_at) AS pulled_at FROM price_pulls
       WHERE status = 'ok' AND game_date IS NOT NULL
         AND (COALESCE(listing_count, 0) > 0 OR median IS NOT NULL OR get_in IS NOT NULL)
       GROUP BY source`,
    ).all<{ source: string; pulled_at: string | null }>();
    const out: Record<string, string | null> = {};
    for (const row of rows.results ?? []) out[row.source] = row.pulled_at;
    return out;
  } catch (error) {
    console.error("admin source freshness", error);
    return {};
  }
}

export async function adminStatusResponse(request: Request, env: Env, now = new Date()): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD" } });
  }
  if (!authorizeAdmin(request.headers.get("Authorization"), env.CRON_SECRET)) {
    return new Response(request.method === "HEAD" ? null : "Admin sign-in required", {
      status: 401,
      headers: {
        ...HEADERS,
        "WWW-Authenticate": 'Basic realm="Wizards 107P admin"',
      },
    });
  }
  const flags = parseFlags(env);
  const book = await readBook(env);
  const [pricedPull, lastAttemptAt] = await Promise.all([
    latestSuccessfulLivePull(env),
    latestLiveAttempt(env),
  ]);
  // Book asof still counts as a successful priced state when archive rows are thin.
  const lastPullAt = latestInstant([pricedPull, ...bookPullInstants(book)]);
  const warnings = ingestStatusWarnings({
    ingestEnabled: flags.ingestEnabled,
    dryRun: flags.dryRun,
    lastPullAt,
    now,
  });
  const savedModel = await latestSavedModel(env);
  let model = savedModel;
  if (model?.holdoutMedianAbsPercent == null) {
    try {
      const scored = await prepareModelFit(env, "admin", now);
      if (scored) {
        model = {
          fittedAt: savedModel?.fittedAt ?? null,
          version: scored.version,
          rows: scored.rows,
          early: scored.early === 1,
          holdoutMedianAbsPercent: scored.holdoutMedianAbsPercent,
        };
      }
    } catch (error) {
      console.error("price model score", error);
    }
  }
  const offerSaved = new URL(request.url).searchParams.get("offer") === "saved";
  let offers: { gameDate: string; total: number; perTicket: number; observedAt: string; note: string | null }[] = [];
  try {
    const { loadInstantOffers } = await import("./instant-offers");
    offers = await loadInstantOffers(env);
  } catch (error) {
    console.error("instant offers", error);
  }
  const sources = await sourceFreshness(env);
  const html = renderAdminStatusPage({
    now,
    sources: [
      { label: "SeatData comps", at: sources.seatdata ?? null },
      { label: "Apify", at: sources.apify ?? null },
      { label: "Instant offers", at: offers.length ? offers.map((o) => o.observedAt).sort().at(-1) ?? null : null },
      { label: "Model fit", at: model?.fittedAt ?? null },
    ],
    warnings,
    ingestEnabled: flags.ingestEnabled,
    dryRun: flags.dryRun,
    lastPullAt,
    lastAttemptAt,
    seatdataKey: Boolean(env.SEATDATA_API_KEY?.trim()),
    apifyToken: Boolean(env.APIFY_TOKEN?.trim()),
    offerSaved,
    games: (book?.games ?? []).map((game) => ({ date: game.date, opponent: game.opponent })),
    offers,
    model,
  });
  const { salesAdminSection, syncSalesFromBook } = await import("./sales");
  await syncSalesFromBook(env).catch((error) => console.error("sales sync", error));
  const withSales = html.replace("</body>", `${await salesAdminSection(env)}\n</body>`);
  return new Response(request.method === "HEAD" ? null : withSales, { status: 200, headers: HEADERS });
}
