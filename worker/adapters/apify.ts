import type { ObservedPull } from "../../src/shared/archive";
import {
  apifyActorInput,
  canStartPaidSource,
  isAbortHttpStatus,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  type SpendState,
} from "../../src/shared/guardrails";
import { dateFromLocal, type AdapterContext, type AdapterResult, type MarketPoint } from "./types";

const HOME_VENUE = "capital-one-arena";
const LOG_TAIL_CHARS = 4000;

type ApifyRun = {
  id?: string;
  status?: string;
  statusMessage?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  buildNumber?: string;
};

/** One event row, read loosely so either supported actor (or a renamed field) still maps. */
export type SeatGeekEventPoint = {
  date: string;
  home: boolean;
  /** True/false when the row names its teams; null when it carries no title at all. */
  wizards: boolean | null;
  getIn: number | null;
  median: number | null;
  listingCount: number | null;
  listings: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function price(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function count(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function first<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) if (value != null) return value;
  return null;
}

/**
 * Map one dataset row to a dated price point. Handles the flat shape
 * (lentic_clockss: lowestPrice/medianPrice/listingCount, venueSlug) and the
 * nested shapes (priceRange.*, stats.*, venue.*) used by other SeatGeek actors.
 */
export function seatGeekEventPoint(raw: unknown): SeatGeekEventPoint | null {
  const row = record(raw);
  if (!row) return null;
  const recordType = str(row.recordType)?.toLowerCase();
  if (recordType && recordType !== "event") return null;

  const venue = record(row.venue);
  const stats = record(row.stats);
  const range = record(row.priceRange) ?? record(row.priceStats) ?? record(row.prices);
  const date =
    dateFromLocal(str(row.datetimeLocal) ?? str(row.datetime_local) ?? str(row.dateTimeLocal)) ??
    dateFromLocal(str(row.datetimeUtc) ?? str(row.datetime_utc) ?? str(row.date));
  if (!date) return null;

  const venueText = [
    str(row.venueSlug),
    str(row.venueName),
    str(venue?.slug),
    str(venue?.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const home = venueText.includes(HOME_VENUE) || venueText.includes("capital one arena");

  const performerNames = Array.isArray(row.performerNames) ? row.performerNames : [];
  const performers = Array.isArray(row.performers) ? row.performers : [];
  const titleText = [
    str(row.title),
    str(row.name),
    str(row.shortTitle),
    str(row.primaryPerformer),
    ...performerNames.map(str),
    ...performers.map((p) => str(record(p)?.slug) ?? str(record(p)?.name)),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const wizards = titleText === "" ? null : titleText.includes("wizards");

  const listingsValue = row.listings;
  return {
    date,
    home,
    wizards,
    getIn: first(
      price(row.lowestPrice),
      price(row.lowest_price),
      price(range?.lowestPrice),
      price(range?.lowest_price),
      price(stats?.lowest_price),
      price(stats?.lowestPrice),
    ),
    median: first(
      price(row.medianPrice),
      price(row.median_price),
      price(range?.medianPrice),
      price(range?.median_price),
      price(stats?.median_price),
      price(stats?.medianPrice),
    ),
    listingCount: first(
      count(row.listingCount),
      count(row.listing_count),
      count(range?.listingCount),
      count(range?.listing_count),
      count(stats?.listing_count),
      count(stats?.listingCount),
      Array.isArray(listingsValue) ? listingsValue.length : null,
    ),
    listings: listingsValue,
  };
}

/**
 * Short, human-readable list of what came back when no home game matched, so
 * the D1 archive row (and /api/export) says why without opening R2.
 */
export function rowSample(rows: unknown[], max = 8): string {
  const parts: string[] = [];
  for (const raw of rows.slice(0, max)) {
    const row = record(raw);
    if (!row) {
      parts.push(typeof raw);
      continue;
    }
    const venue = record(row.venue);
    const processed = row.eventsProcessed;
    const bits = [
      str(row.recordType),
      typeof processed === "number" ? `eventsProcessed=${processed}` : undefined,
      str(row.datetimeLocal) ?? str(row.datetimeUtc) ?? str(row.date),
      str(row.venueSlug) ?? str(venue?.slug) ?? str(row.venueName) ?? str(venue?.name),
      str(row.title) ?? str(row.name) ?? str(row.note),
    ].filter(Boolean);
    parts.push(bits.join(" | ").slice(0, 140));
  }
  return parts.join(" ; ");
}

/** One line of text from a log or status message, last `max` chars. */
function tailLine(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

/**
 * Why an Apify run produced no home game, short enough for the D1 note:
 * what rows came back, the run's status message, and the end of its log.
 */
export function emptyRunNote(
  rows: unknown[],
  diag: { statusMessage?: string | null; logTail?: string | null },
): string {
  const parts: string[] = [];
  if (rows.length > 0) parts.push(`rows: ${rowSample(rows)}`);
  const status = tailLine(diag.statusMessage, 200);
  if (status) parts.push(`status: ${status}`);
  const log = tailLine(diag.logTail, 700);
  if (log) parts.push(`log: ${log}`);
  return parts.join(" || ");
}

/** Home Wizards games only, one point per date (first row wins). */
export function homePointsFromRows(rows: unknown[]): { date: string; point: SeatGeekEventPoint }[] {
  const byDate = new Map<string, SeatGeekEventPoint>();
  for (const raw of rows) {
    const point = seatGeekEventPoint(raw);
    if (!point || !point.home || point.wizards === false) continue;
    if (!byDate.has(point.date)) byDate.set(point.date, point);
  }
  return [...byDate.entries()].map(([date, point]) => ({ date, point }));
}

function terminal(status: string | undefined): boolean {
  return ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "TIMED_OUT"].includes(
    status ?? "",
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function apifyJson(
  token: string,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Last few KB of the run log, so an empty run says why in the archive. Never throws. */
async function apifyLogTail(token: string, runId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/log`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/plain" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return `log_http_${res.status}`;
    }
    const text = await res.text();
    return text.length > LOG_TAIL_CHARS ? text.slice(-LOG_TAIL_CHARS) : text;
  } catch (error) {
    return `log_error ${error instanceof Error ? error.message : String(error)}`;
  }
}

function apifyCost(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { data?: ApifyRun; usageTotalUsd?: number }).data?.usageTotalUsd ??
    (body as { usageTotalUsd?: number }).usageTotalUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function failed(status: number | null, error: string, paid: boolean, raw?: unknown): ObservedPull {
  return {
    gameDate: null,
    status: "failed",
    paid,
    httpStatus: status,
    error,
    raw: raw ?? null,
    note: "apify run",
  };
}

export function apifyRunUrl(actor: string, query: Record<string, string>): string {
  return `https://api.apify.com/v2/acts/${actor}/runs?${new URLSearchParams(query)}`;
}

export async function runApify(
  ctx: AdapterContext,
  spend: SpendState,
  etDate: string,
): Promise<{ result: AdapterResult; spend: SpendState; observations: ObservedPull[] }> {
  const flags = parseFlags(ctx.env);
  const gate = canStartPaidSource({
    flags,
    source: "apify",
    runPaidAttempts: 0,
    spend: spend.sources.apify,
    etDate,
    hasCredential: Boolean(ctx.env.APIFY_TOKEN),
  });

  if (!gate.ok) {
    return {
      result: { source: "apify", paid: false, aborted: gate.reason, points: [] },
      spend,
      observations: [],
    };
  }

  const token = ctx.env.APIFY_TOKEN as string;
  const actor = flags.apifyActor;
  const input = apifyActorInput(flags);
  const query: Record<string, string> = {
    maxTotalChargeUsd: flags.apifyMaxTotalChargeUsd.toFixed(2),
    waitForFinish: "60",
    timeout: "180",
  };
  if (flags.apifyActorBuild) query.build = flags.apifyActorBuild;
  const runMeta = { actor, build: flags.apifyActorBuild ?? "default", input };

  const started = await apifyJson(token, apifyRunUrl(actor, query), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (isAbortHttpStatus(started.status)) {
    spend.sources.apify = openCircuit(spend.sources.apify, etDate, `start_${started.status}`);
    return {
      result: { source: "apify", paid: false, aborted: `http_${started.status}`, points: [] },
      spend,
      observations: [failed(started.status, `http_${started.status}`, false, { ...runMeta, body: started.body })],
    };
  }

  if (started.status >= 400) {
    return {
      result: { source: "apify", paid: false, aborted: `start_${started.status}`, points: [] },
      spend,
      observations: [failed(started.status, `start_${started.status}`, false, { ...runMeta, body: started.body })],
    };
  }

  spend.sources.apify = recordPaidAttempt(spend.sources.apify, etDate);

  const run = (started.body as { data?: ApifyRun })?.data ?? (started.body as ApifyRun);
  if (!run?.id) {
    return {
      result: { source: "apify", paid: true, aborted: "no_run_id", points: [] },
      spend,
      observations: [failed(started.status, "no_run_id", true, { ...runMeta, body: started.body })],
    };
  }

  let status = run.status;
  let statusMessage = run.statusMessage ?? null;
  let buildNumber = run.buildNumber ?? null;
  let datasetId = run.defaultDatasetId;
  let costUsd = apifyCost(started.body);
  for (let i = 0; i < 15 && !terminal(status); i += 1) {
    await sleep(4000);
    const poll = await apifyJson(token, `https://api.apify.com/v2/actor-runs/${run.id}`);
    if (isAbortHttpStatus(poll.status)) {
      spend.sources.apify = openCircuit(spend.sources.apify, etDate, `poll_${poll.status}`);
      return {
        result: { source: "apify", paid: true, aborted: `http_${poll.status}`, points: [] },
        spend,
        observations: [failed(poll.status, `http_${poll.status}`, true, poll.body)],
      };
    }
    const data = (poll.body as { data?: ApifyRun })?.data;
    status = data?.status;
    statusMessage = data?.statusMessage ?? statusMessage;
    buildNumber = data?.buildNumber ?? buildNumber;
    datasetId = data?.defaultDatasetId ?? datasetId;
    costUsd = apifyCost(poll.body) ?? costUsd;
  }

  const diagnostics = async () => ({
    ...runMeta,
    runId: run.id,
    status,
    statusMessage,
    buildNumber,
    logTail: await apifyLogTail(token, run.id as string),
  });

  if (status !== "SUCCEEDED" || !datasetId) {
    return {
      result: { source: "apify", paid: true, aborted: status ?? "run_incomplete", points: [] },
      spend,
      observations: [
        {
          ...failed(null, status ?? "run_incomplete", true, await diagnostics()),
          costUsd,
          note: `apify run ${run.id}`,
        },
      ],
    };
  }

  const items = await apifyJson(
    token,
    `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&limit=${flags.apifyMaxEvents + 1}`,
  );
  if (isAbortHttpStatus(items.status)) {
    spend.sources.apify = openCircuit(spend.sources.apify, etDate, `items_${items.status}`);
    return {
      result: { source: "apify", paid: true, aborted: `http_${items.status}`, points: [] },
      spend,
      observations: [failed(items.status, `http_${items.status}`, true, items.body)],
    };
  }

  const rows = Array.isArray(items.body) ? (items.body as unknown[]) : [];
  const home = homePointsFromRows(rows);
  const points: MarketPoint[] = [];
  const empty = home.length === 0;
  const diag = empty ? await diagnostics() : null;
  const observations: ObservedPull[] = [
    {
      gameDate: null,
      status: empty ? "empty" : "ok",
      paid: true,
      costUsd,
      error: empty ? (rows.length === 0 ? "apify_zero_rows" : "apify_no_home_rows") : null,
      note: `apify run ${run.id} (${actor}${buildNumber ? ` ${buildNumber}` : ""})${
        diag ? ` ${emptyRunNote(rows, diag)}` : ""
      }`,
      raw: diag ? { ...diag, rows: items.body } : items.body,
      listingCount: rows.length,
    },
  ];
  for (const { date, point } of home) {
    points.push({
      date,
      getIn: point.getIn,
      median: point.median,
      listingCount: point.listingCount,
    });
    observations.push({
      gameDate: date,
      opponent: ctx.games.find((game) => game.date === date)?.opponent ?? null,
      status: "ok",
      paid: true,
      getIn: point.getIn,
      median: point.median,
      listingCount: point.listingCount,
      listings: Array.isArray(point.listings) ? point.listings : undefined,
      note: "cost is on the apify run row",
    });
  }

  return {
    result: {
      source: "apify",
      paid: true,
      aborted: empty ? (rows.length === 0 ? "zero_rows" : "no_home_rows") : undefined,
      points,
    },
    spend,
    observations,
  };
}
