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
  seatdataKey: boolean;
  apifyToken: boolean;
  offerSaved?: boolean;
  games?: readonly { date: string; opponent: string }[];
  offers?: readonly { gameDate: string; total: number; perTicket: number; observedAt: string; note: string | null }[];
  model?: {
    fittedAt: string | null;
    rows: number | null;
    early: boolean | null;
    holdoutMedianAbsPercent: number | null;
  } | null;
}): string {
  const last = args.lastPullAt ? formatEtStamp(new Date(args.lastPullAt)) : "none";
  const banners = args.warnings
    .map((warning) => `<p class="warn" role="alert">${escapeHtml(warning)}</p>`)
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
  </style>
</head>
<body>
  <p><a href="/">Ticket book</a></p>
  <h1>Admin status</h1>
  ${banners}
  <dl>
    <dt>Ingest</dt><dd>${args.ingestEnabled ? "on" : "off"}</dd>
    <dt>Dry run</dt><dd>${args.dryRun ? "on" : "off"}</dd>
    <dt>Last successful pull</dt><dd>${escapeHtml(last)} ET</dd>
    <dt>SeatData key</dt><dd>${args.seatdataKey ? "set" : "missing"}</dd>
    <dt>Apify token</dt><dd>${args.apifyToken ? "set" : "missing"}</dd>
    <dt>Caps</dt><dd>SeatData 20 per run, 25 per ET day. Apify $0.50 and 50 events. Listings off.</dd>
    <dt>Next-check error</dt><dd>${modelErrorText(args.model)}</dd>
  </dl>
  <h2>Instant offer</h2>
  ${saved}
  <p>Log the sell-now offer for a game, such as Get Paid $26.60 ($13.30 per ticket). Enter the pair total, the per-ticket amount, or both. Saving does not list anything.</p>
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

async function latestLivePull(env: Env): Promise<string | null> {
  try {
    await ensureArchive(env);
    const row = await env.DB.prepare(
      `SELECT MAX(pulled_at) AS pulled_at FROM price_pulls
       WHERE source IN ('seatdata', 'apify')
         AND status IN ('ok', 'empty')
         AND trigger_name IN ('cron', 'http')`,
    ).first<{ pulled_at: string | null }>();
    return row?.pulled_at ?? null;
  } catch (error) {
    console.error("admin last pull", error);
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
  const lastPullAt = latestInstant([await latestLivePull(env), ...bookPullInstants(book)]);
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
  const html = renderAdminStatusPage({
    warnings,
    ingestEnabled: flags.ingestEnabled,
    dryRun: flags.dryRun,
    lastPullAt,
    seatdataKey: Boolean(env.SEATDATA_API_KEY?.trim()),
    apifyToken: Boolean(env.APIFY_TOKEN?.trim()),
    offerSaved,
    games: (book?.games ?? []).map((game) => ({ date: game.date, opponent: game.opponent })),
    offers,
    model,
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: HEADERS });
}
