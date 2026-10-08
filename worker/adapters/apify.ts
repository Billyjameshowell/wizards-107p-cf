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

const ACTOR = "lentic_clockss~seatgeek-scraper";
const HOME_VENUE = "capital-one-arena";

type SeatGeekRow = {
  eventId?: string;
  title?: string;
  name?: string;
  datetimeUtc?: string;
  datetimeLocal?: string;
  venueSlug?: string;
  venueName?: string;
  lowestPrice?: number;
  medianPrice?: number;
  listingCount?: number;
};

type ApifyRun = {
  id?: string;
  status?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
};

function isHome(row: SeatGeekRow): boolean {
  const slug = (row.venueSlug ?? "").toLowerCase();
  const name = (row.venueName ?? "").toLowerCase();
  return slug === HOME_VENUE || name.includes("capital one arena");
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

function apifyCost(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { data?: ApifyRun; usageTotalUsd?: number };
  const value = record.data?.usageTotalUsd ?? record.usageTotalUsd;
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
  const input = apifyActorInput(flags);
  const qs = new URLSearchParams({
    maxTotalChargeUsd: flags.apifyMaxTotalChargeUsd.toFixed(2),
    waitForFinish: "60",
    timeout: "180",
  });

  const started = await apifyJson(
    token,
    `https://api.apify.com/v2/actors/${ACTOR}/runs?${qs}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  if (isAbortHttpStatus(started.status)) {
    spend.sources.apify = openCircuit(spend.sources.apify, etDate, `start_${started.status}`);
    return {
      result: { source: "apify", paid: false, aborted: `http_${started.status}`, points: [] },
      spend,
      observations: [failed(started.status, `http_${started.status}`, false, started.body)],
    };
  }

  spend.sources.apify = recordPaidAttempt(spend.sources.apify, etDate);

  const run = (started.body as { data?: ApifyRun })?.data ?? (started.body as ApifyRun);
  if (!run?.id) {
    return {
      result: { source: "apify", paid: true, aborted: "no_run_id", points: [] },
      spend,
      observations: [failed(started.status, "no_run_id", true, started.body)],
    };
  }

  let status = run.status;
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
    datasetId = data?.defaultDatasetId ?? datasetId;
    costUsd = apifyCost(poll.body) ?? costUsd;
  }

  if (status !== "SUCCEEDED" || !datasetId) {
    return {
      result: { source: "apify", paid: true, aborted: status ?? "run_incomplete", points: [] },
      spend,
      observations: [failed(null, status ?? "run_incomplete", true)],
    };
  }

  const items = await apifyJson(
    token,
    `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&limit=${flags.apifyMaxEvents}`,
  );
  if (isAbortHttpStatus(items.status)) {
    spend.sources.apify = openCircuit(spend.sources.apify, etDate, `items_${items.status}`);
    return {
      result: { source: "apify", paid: true, aborted: `http_${items.status}`, points: [] },
      spend,
      observations: [failed(items.status, `http_${items.status}`, true, items.body)],
    };
  }

  const rows = (Array.isArray(items.body) ? items.body : []) as SeatGeekRow[];
  const points: MarketPoint[] = [];
  const observations: ObservedPull[] = [
    {
      gameDate: null,
      status: "ok",
      paid: true,
      costUsd,
      note: run.id ? `apify run ${run.id}` : "apify run",
      raw: items.body,
      listingCount: rows.length,
    },
  ];
  for (const row of rows) {
    if (!isHome(row)) continue;
    const date = dateFromLocal(row.datetimeLocal) ?? dateFromLocal(row.datetimeUtc);
    if (!date) continue;
    const listings = (row as SeatGeekRow & { listings?: unknown }).listings;
    points.push({
      date,
      getIn: row.lowestPrice ?? null,
      median: row.medianPrice ?? null,
      listingCount: row.listingCount ?? null,
    });
    observations.push({
      gameDate: date,
      opponent: ctx.games.find((game) => game.date === date)?.opponent ?? null,
      status: "ok",
      paid: true,
      getIn: row.lowestPrice ?? null,
      median: row.medianPrice ?? null,
      listingCount: row.listingCount ?? null,
      listings,
      note: "cost is on the apify run row",
    });
  }

  return {
    result: { source: "apify", paid: true, points },
    spend,
    observations,
  };
}
