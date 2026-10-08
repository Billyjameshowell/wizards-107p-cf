import { bookPullInstants, ingestStatusWarnings, latestInstant } from "../src/shared/ingest-status";
import { formatEtStamp } from "../src/shared/book";
import { authorizeBearer, parseFlags, timingSafeEqual } from "../src/shared/guardrails";
import { ensureArchive } from "./archive-store";
import { readBook } from "./store";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

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
}): string {
  const last = args.lastPullAt ? formatEtStamp(new Date(args.lastPullAt)) : "none";
  const attempt = args.lastAttemptAt ? formatEtStamp(new Date(args.lastAttemptAt)) : "none";
  const banners = args.warnings
    .map((warning) => `<p class="warn" role="alert">${escapeHtml(warning)}</p>`)
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
  </style>
</head>
<body>
  <p><a href="/">Ticket book</a></p>
  <h1>Admin status</h1>
  ${banners}
  <dl>
    <dt>Ingest</dt><dd>${args.ingestEnabled ? "on" : "off"}</dd>
    <dt>Dry run</dt><dd>${args.dryRun ? "on" : "off"}</dd>
    <dt>Last successful pull</dt><dd>${escapeHtml(last)} ET <span style="font-weight:400;color:#445">(home-game prices landed)</span></dd>
    <dt>Last attempt</dt><dd>${escapeHtml(attempt)} ET <span style="font-weight:400;color:#445">(any cron/http SeatData or Apify run)</span></dd>
    <dt>SeatData key</dt><dd>${args.seatdataKey ? "set" : "missing"}</dd>
    <dt>Apify token</dt><dd>${args.apifyToken ? "set" : "missing"}</dd>
    <dt>Caps</dt><dd>SeatData 20 per run, 25 per ET day. Apify $0.50 and 50 events. Listings off.</dd>
  </dl>
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
  const html = renderAdminStatusPage({
    warnings,
    ingestEnabled: flags.ingestEnabled,
    dryRun: flags.dryRun,
    lastPullAt,
    lastAttemptAt,
    seatdataKey: Boolean(env.SEATDATA_API_KEY?.trim()),
    apifyToken: Boolean(env.APIFY_TOKEN?.trim()),
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: HEADERS });
}
