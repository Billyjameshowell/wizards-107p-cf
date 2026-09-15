import { ADMIN_STYLE, ADMIN_MASTHEAD } from "./admin-style";
import { teamForOpponent } from "../src/shared/teams";
import { formatEtStamp, type Book, type Game } from "../src/shared/book";
import {
  authorizeBearer,
  etDateFrom,
  isUsableCredential,
  HARD_CAPS,
  parseFlags,
  type Flags,
  type SpendState,
  timingSafeEqual,
} from "../src/shared/guardrails";
import { readBook, readSpend, SEED_BOOK } from "./store";
import { readSpendLedger, readSpendTotals, type SpendTotals, type SpendLedgerRow } from "./spend";
import {
  authorizeAdminSession,
  createAdminSessionToken,
  MAX_LOGIN_BODY_BYTES,
  sessionSetCookie,
} from "./admin-auth";

export type AdminStatusSnapshot = {
  book: Book;
  flags: Flags;
  spend: SpendState;
  billing?: SpendTotals;
  ledger?: SpendLedgerRow[];
  seedStatus?: { status?: string; at?: string; pricedGames?: number; totalGames?: number; reason?: string };
  credentials: {
    seatdata: boolean;
    apify: boolean;
  };
  generatedAtEt: string;
  /** Values used only to redact diagnostics; never rendered. */
  redactionSecrets: string[];
};

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function sanitizeText(value: unknown, secrets: readonly string[], maxLength = 240): string {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/bearer\s+[^\s<>&"']+/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s<>&"']+/gi,
      "$1[redacted]",
    )
    .trim();
  text = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  return text.slice(0, maxLength);
}

function safeText(value: unknown, secrets: readonly string[], maxLength = 240): string {
  return escapeHtml(sanitizeText(value, secrets, maxLength));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function money(value: unknown): string {
  const amount = finiteNumber(value);
  return amount == null ? "—" : `$${amount.toFixed(2)}`;
}

function count(value: unknown): string {
  return finiteNumber(value)?.toFixed(0) ?? "0";
}

function cap(value: unknown): string {
  return finiteNumber(value)?.toFixed(0) ?? "—";
}

function boolLabel(value: boolean): string {
  return value ? "on" : "off";
}

function credentialLabel(value: boolean): string {
  return value ? "present" : "missing";
}

function sourceLastRun(
  snapshot: AdminStatusSnapshot,
  source: "seatdata" | "apify",
): { pulls: number; paid: boolean | null; aborted: string } {
  const value = snapshot.spend.lastRun?.sources?.[source];
  return {
    pulls: value?.pulls ?? 0,
    paid: typeof value?.paid === "boolean" ? value.paid : null,
    aborted: value?.aborted ?? "",
  };
}

function sourceError(snapshot: AdminStatusSnapshot, source: "seatdata" | "apify"): string {
  return snapshot.spend.sources[source]?.lastError ?? sourceLastRun(snapshot, source).aborted;
}

function renderSourceRows(snapshot: AdminStatusSnapshot): string {
  const seatSpend = snapshot.spend.sources.seatdata;
  const apifySpend = snapshot.spend.sources.apify;
  const seatRun = sourceLastRun(snapshot, "seatdata");
  const seatError = sourceError(snapshot, "seatdata");
  const apifyError = sourceError(snapshot, "apify");
  const seatCircuit = seatSpend?.circuitOpenEtDate
    ? `open (${safeText(seatSpend.circuitOpenEtDate, snapshot.redactionSecrets)})`
    : "closed";
  const apifyCircuit = apifySpend?.circuitOpenEtDate
    ? `open (${safeText(apifySpend.circuitOpenEtDate, snapshot.redactionSecrets)})`
    : "closed";

  return `
    <tr>
      <th scope="row">SeatData</th>
      <td>${credentialLabel(snapshot.credentials.seatdata)}</td>
      <td>${count(seatSpend?.paidAttemptsToday)} today; run cap ${HARD_CAPS.paidAttemptsPerSourcePerRun}</td>
      <td>${count(seatRun.pulls)} / ${cap(snapshot.flags.seatdataMaxPullsPerRun)}</td>
      <td>${count(seatSpend?.pullsToday)} / ${cap(snapshot.flags.seatdataMaxPullsPerEtDay)}</td>
      <td>—</td>
      <td>${seatCircuit}</td>
      <td>${safeText(seatError || "—", snapshot.redactionSecrets)}</td>
    </tr>
    <tr>
      <th scope="row">Apify</th>
      <td>${credentialLabel(snapshot.credentials.apify)}</td>
      <td>${count(apifySpend?.paidAttemptsToday)} today; run cap ${HARD_CAPS.paidAttemptsPerSourcePerRun}</td>
      <td>—</td>
      <td>—</td>
      <td>$${snapshot.flags.apifyMaxTotalChargeUsd.toFixed(2)} cap</td>
      <td>${apifyCircuit}</td>
      <td>${safeText(apifyError || "—", snapshot.redactionSecrets)}</td>
    </tr>`;
}

function renderLastRun(snapshot: AdminStatusSnapshot): string {
  const lastRun = snapshot.spend.lastRun;
  if (!lastRun) return "<p>No run recorded.</p>";

  const sourceRows = Object.entries(lastRun.sources ?? {})
    .map(([source, detail]) => {
      const sourceDetail = detail as {
        attempted?: boolean;
        paid?: boolean;
        aborted?: string;
        pulls?: number;
      };
      return `<li>${safeText(source, snapshot.redactionSecrets)}: attempted=${
        sourceDetail.attempted === true ? "yes" : "no"
      }, paid=${sourceDetail.paid === true ? "yes" : "no"}, pulls=${count(
        sourceDetail.pulls,
      )}${sourceDetail.aborted ? `, error=${safeText(sourceDetail.aborted, snapshot.redactionSecrets)}` : ""}</li>`;
    })
    .join("");

  return `<dl class="facts">
    <div><dt>At</dt><dd>${safeText(lastRun.at, snapshot.redactionSecrets)}</dd></div>
    <div><dt>Trigger</dt><dd>${safeText(lastRun.trigger, snapshot.redactionSecrets)}</dd></div>
    <div><dt>Ingest</dt><dd>${boolLabel(lastRun.ingestEnabled)}</dd></div>
    <div><dt>Dry run</dt><dd>${boolLabel(lastRun.dryRun)}</dd></div>
    <div><dt>Book updated</dt><dd>${lastRun.bookUpdated === true ? "yes" : "no"}</dd></div>
    <div><dt>Reason</dt><dd>${safeText(lastRun.skippedReason || "—", snapshot.redactionSecrets)}</dd></div>
  </dl>
  <ul class="source-notes">${sourceRows || "<li>No source details recorded.</li>"}</ul>`;
}

function renderBilling(snapshot: AdminStatusSnapshot): string {
  const billing = snapshot.billing;
  if (!billing) return "<h2>Spend in USD</h2><p>No billing records available.</p>";
  const totalRows = (["seatdata", "apify", "blended"] as const).map(source => {
    const total = source === "blended" ? billing.blended : billing.sources[source];
    return `<tr><th scope="row">${source === "blended" ? "Blended" : source === "seatdata" ? "SeatData" : "Apify"}</th>
      <td>${money(total.actualUsd)}</td><td>${money(total.estimatedUsd)}</td>
      <td>${money(total.actualUsd + total.estimatedUsd)}</td></tr>`;
  }).join("");
  const lastRows = (["seatdata", "apify"] as const).map(source => {
    const detail = snapshot.spend.lastRun?.sources[source];
    const cost = detail?.spend;
    return `<tr><th scope="row">${source === "seatdata" ? "SeatData" : "Apify"}</th>
      <td>${cost ? money(cost.actualUsd) : "—"}</td><td>${cost ? money(cost.estimatedUsd) : "—"}</td>
      <td>${count(cost?.pulls ?? detail?.pulls)} pulls; ${count(cost?.eventsFetched)} events</td>
      <td>${safeText(cost?.status ?? detail?.aborted ?? "—", snapshot.redactionSecrets)}</td></tr>`;
  }).join("");
  const records = (snapshot.ledger ?? []).map(row => `<tr>
    <td>${safeText(row.at, snapshot.redactionSecrets)}</td><td>${safeText(row.source, snapshot.redactionSecrets)}</td>
    <td>${safeText(row.details.gameDate ?? row.details.date ?? row.details.runId ?? row.details.kind ?? "—", snapshot.redactionSecrets)}</td>
    <td>${money(row.actualUsd)}</td><td>${money(row.estimatedUsd)}</td><td>${money(row.reservedUsd)}</td>
    <td>${count(row.details.pulls ?? 1)} pulls; ${count(row.details.eventsFetched)} events</td>
    <td>${safeText(row.details.status ?? "reserved", snapshot.redactionSecrets)}</td></tr>`).join("");
  return `<h2 class="accent">Daily spend · ${safeText(billing.etDate, snapshot.redactionSecrets)} ET</h2>
    <p class="muted">USD. Actual = confirmed billing; estimated = unresolved or historical charges. Total includes both. SeatData refreshed pulls × $0.04 PAYG. Apify uses terminal run billing, otherwise its reserved ceiling. Reservations are ceilings, not additional charges.</p>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Actual USD</th><th>Estimated USD</th><th>Total USD</th></tr></thead><tbody>${totalRows}</tbody></table></div>
    <h2>Last run cost by source${snapshot.spend.lastRun?.seed ? " · one-shot seed" : ""}</h2>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Actual USD</th><th>Estimated USD</th><th>Fetched</th><th>Status</th></tr></thead><tbody>${lastRows}</tbody></table></div>
    <h2>Recent pull costs</h2><p class="muted">Latest 100 durable billing records. Earlier unreceipted usage is estimated.</p>
    <div class="table-wrap"><table><thead><tr><th>At (UTC)</th><th>Source</th><th>Game / run</th><th>Actual USD</th><th>Estimated USD</th><th>Reserved USD</th><th>Fetched</th><th>Status</th></tr></thead><tbody>${records || '<tr><td colspan="8">No pulls recorded.</td></tr>'}</tbody></table></div>`;
}

function pricedGames(book: Book): Game[] {
  return [...(book.games ?? [])]
    .filter((game) => {
      const details = game.market_details;
      return (
        finiteNumber(game.advised_ask) != null ||
        (details != null
          ? finiteNumber(details.get_in) != null || finiteNumber(details.median) != null
          : finiteNumber(game.market_get_in) != null || finiteNumber(game.market_median) != null)
      );
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function marketGetIn(game: Game): number | null {
  return finiteNumber(game.market_details ? game.market_details.get_in : game.market_get_in);
}

function marketMedian(game: Game): number | null {
  return finiteNumber(game.market_details ? game.market_details.median : game.market_median);
}

function renderPriceRows(snapshot: AdminStatusSnapshot): string {
  const games = pricedGames(snapshot.book);
  if (games.length === 0) {
    return '<tr><td colspan="8">No market prices recorded yet.</td></tr>';
  }
  return games
    .map(
      (game) => `<tr>
      <td>${safeText(game.date, snapshot.redactionSecrets)}</td>
      <td class="team-name"><img class="team-logo" src="${teamForOpponent(game.opponent).logo}" width="16" height="16" alt="">${safeText(game.opponent, snapshot.redactionSecrets)}</td>
      <td>${safeText(game.sit_or_sell, snapshot.redactionSecrets)}</td>
      <td>${money(game.advised_ask)}</td>
      <td>${money(marketGetIn(game))}</td>
      <td>${money(marketMedian(game))}</td>
      <td>${finiteNumber(game.listing_count)?.toFixed(0) ?? "—"}</td>
      <td>${safeText(game.market_updated_at_et || game.market_details?.asof || "Not recorded", snapshot.redactionSecrets)}</td>
    </tr>`,
    )
    .join("");
}

export function authorizeAdmin(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.trim() === "" || !header) return false;
  if (authorizeBearer(header, secret)) return true;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  try {
    const decoded = atob(match[1]);
    return timingSafeEqual(decoded, `admin:${secret}`);
  } catch {
    return false;
  }
}

async function authorizeAdminRequest(request: Request, secret: string | undefined): Promise<boolean> {
  if (authorizeAdmin(request.headers.get("Authorization"), secret)) return true;
  return authorizeAdminSession(request.headers.get("Cookie"), secret);
}

const loginHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

export function renderAdminLoginHtml(error = ""): string {
  const errorMarkup = error ? `<p role="alert" class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex,nofollow">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Wizards 107P admin sign in</title>
    <style>${ADMIN_STYLE}</style>
  </head>
  <body><main class="login-sheet">${ADMIN_MASTHEAD}
    <div class="login-panel"><h1>Admin sign in</h1><p class="muted">Sign in to view pull status, caps, and market records.</p>
    ${errorMarkup}
    <form method="post" action="/admin" autocomplete="off">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <label class="remember"><input name="remember" value="30" type="checkbox"> Remember me for 30 days</label>
      <button type="submit">Sign in</button>
    </form></div><footer>Wizards 107P · <a href="/">Return to the ticket book</a></footer>
  </main></body>
</html>`;
}

function sameOriginPost(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  // Privacy policies can replace a navigation POST's Origin with "null".
  // Accept that only when browser fetch metadata confirms our own origin.
  if (!origin || origin === "null") return fetchSite === "same-origin";
  return origin === new URL(request.url).origin;
}

async function readLoginForm(request: Request): Promise<URLSearchParams | null> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength != null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LOGIN_BODY_BYTES) return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

export async function adminLoginResponse(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    return new Response(request.method === "HEAD" ? null : renderAdminLoginHtml(), {
      status: 200,
      headers: loginHeaders,
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...loginHeaders, Allow: "GET, HEAD, POST" },
    });
  }
  if (!sameOriginPost(request)) {
    return new Response("Forbidden", { status: 403, headers: loginHeaders });
  }
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return new Response("Unsupported Media Type", { status: 415, headers: loginHeaders });
  }
  const form = await readLoginForm(request);
  if (!form) return new Response("Request Entity Too Large", { status: 413, headers: loginHeaders });
  const password = form.get("password") ?? "";
  const validPassword = Boolean(env.CRON_SECRET) && timingSafeEqual(password, env.CRON_SECRET ?? "");
  if (!validPassword) {
    return new Response(renderAdminLoginHtml("Invalid password."), { status: 401, headers: loginHeaders });
  }
  const remember = form.get("remember") === "30";
  const token = await createAdminSessionToken(env.CRON_SECRET, remember);
  if (!token) return new Response("Admin authentication unavailable", { status: 503, headers: loginHeaders });
  return new Response(null, {
    status: 303,
    headers: {
      ...loginHeaders,
      Location: "/admin",
      "Set-Cookie": sessionSetCookie(token, remember),
    },
  });
}

export async function readAdminStatus(env: Env, now = new Date()): Promise<AdminStatusSnapshot> {
  const [storedBook, spend, billing, ledger] = await Promise.all([readBook(env), readSpend(env, now), readSpendTotals(env, etDateFrom(now)), readSpendLedger(env, { limit: 100 })]);
  const seedRow = await env.DB.prepare("SELECT value FROM store WHERE key = 'seed_20260915'").first<{ value: string }>();
  let seedStatus: AdminStatusSnapshot["seedStatus"];
  try { seedStatus = seedRow ? JSON.parse(seedRow.value) : undefined; } catch { seedStatus = undefined; }
  const book = storedBook ?? SEED_BOOK;
  const flags = parseFlags(env);
  const redactionSecrets = [env.CRON_SECRET, env.SEATDATA_API_KEY, env.APIFY_TOKEN].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    book,
    flags,
    spend,
    billing,
    ledger,
    seedStatus,
    credentials: {
      seatdata: isUsableCredential(env.SEATDATA_API_KEY),
      apify: isUsableCredential(env.APIFY_TOKEN),
    },
    generatedAtEt: formatEtStamp(now),
    redactionSecrets,
  };
}

export function renderAdminStatusHtml(snapshot: AdminStatusSnapshot): string {
  const { book, flags } = snapshot;
  const prices = pricedGames(book);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex,nofollow">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Wizards 107P admin status</title>
    <style>${ADMIN_STYLE}</style>
  </head>
  <body>
    <main>${ADMIN_MASTHEAD}
      <h1>Wizards 107P admin status</h1>
      <div class="meta"><p class="muted">Generated ${safeText(snapshot.generatedAtEt, snapshot.redactionSecrets)} ET · ${
        prices.length
      } priced games · ${book.games.length} total games</p>
      <p class="muted">View only · <a href="/admin?login=1">Remember this browser</a></p></div>

      <h2>Runtime</h2>
      <dl class="facts">
        <div><dt>Ingest enabled</dt><dd>${boolLabel(flags.ingestEnabled)}</dd></div>
        <div><dt>Dry run</dt><dd>${boolLabel(flags.dryRun)}</dd></div>
        <div><dt>Sources</dt><dd>${safeText(flags.sources.join(", "), snapshot.redactionSecrets)}</dd></div>
        <div><dt>Apify listings</dt><dd>${boolLabel(flags.apifyIncludeListings)}</dd></div>
        <div><dt>SeatData key</dt><dd>${credentialLabel(snapshot.credentials.seatdata)}</dd></div>
        <div><dt>Apify token</dt><dd>${credentialLabel(snapshot.credentials.apify)}</dd></div>
      </dl>

      <h2>One-shot seed</h2>
      <p>${snapshot.seedStatus ? `Claim consumed · ${safeText(snapshot.seedStatus.status, snapshot.redactionSecrets)} · ${safeText(snapshot.seedStatus.at, snapshot.redactionSecrets)}${snapshot.seedStatus.totalGames != null ? ` · ${count(snapshot.seedStatus.pricedGames)} / ${count(snapshot.seedStatus.totalGames)} homes with advised asks` : ""}` : "Not yet claimed."} Current book: ${prices.length} / ${book.games.length} homes priced.${snapshot.seedStatus?.reason ? ` ${safeText(snapshot.seedStatus.reason, snapshot.redactionSecrets)}` : ""}</p>

      <h2>Last run</h2>
      ${renderLastRun(snapshot)}

      ${renderBilling(snapshot)}

      <h2 class="accent">Spend counters and caps</h2>
      <p class="muted">Counters reserve every potentially paid request before sending, including failures. Normal SeatData limits are 20/run and 25/ET day. The single-use seed allows 50/run and 100/ET day, then normal limits resume. Billing is shown separately above.</p>
      <div class="table-wrap" role="region" aria-label="Source usage and caps" tabindex="0"><table>
        <thead><tr><th>Source</th><th>Credential</th><th>Paid attempts</th><th>Pulls this run / cap</th><th>Pulls ET day / cap</th><th>Charge cap</th><th>Circuit</th><th>Last error</th></tr></thead>
        <tbody>${renderSourceRows(snapshot)}</tbody>
      </table></div>

      <h2>Key game prices</h2>
      <p class="muted">Book timestamp: ${safeText(book.asof_et, snapshot.redactionSecrets)} ET</p>
      <div class="table-wrap" role="region" aria-label="Game price records" tabindex="0"><table class="prices">
        <thead><tr><th>Date</th><th>Opponent</th><th>Sit/Sell</th><th>Advised ask</th><th>Get-in</th><th>Median</th><th>Listings</th><th>Last updated</th></tr></thead>
        <tbody>${renderPriceRows(snapshot)}</tbody>
      </table></div>
      <footer>Wizards 107P · Read-only operational status · <a href="/">Return to the ticket book</a></footer>
    </main>
  </body>
</html>`;
}

export async function adminResponse(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/admin") {
    return adminLoginResponse(request, env);
  }
  if ((request.method === "GET" || request.method === "HEAD") && url.searchParams.get("login") === "1") {
    return new Response(request.method === "HEAD" ? null : renderAdminLoginHtml(), {
      status: 200,
      headers: loginHeaders,
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" },
    });
  }
  if (!(await authorizeAdminRequest(request, env.CRON_SECRET))) {
    if ((request.method === "GET" || request.method === "HEAD") && !request.headers.get("Authorization")) {
      return new Response(request.method === "HEAD" ? null : "Redirecting to admin sign in", {
        status: 302,
        headers: { ...headers, Location: "/admin/login" },
      });
    }
    return new Response(request.method === "HEAD" ? null : "Unauthorized", {
      status: 401,
      headers: { ...headers, "WWW-Authenticate": 'Basic realm="Wizards 107P admin"' },
    });
  }
  try {
    const snapshot = await readAdminStatus(env);
    return new Response(request.method === "HEAD" ? null : renderAdminStatusHtml(snapshot), {
      status: 200,
      headers,
    });
  } catch {
    return new Response(request.method === "HEAD" ? null : "Admin status unavailable", {
      status: 500,
      headers,
    });
  }
}
