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

export async function runApify(
  ctx: AdapterContext,
  spend: SpendState,
  etDate: string,
): Promise<{ result: AdapterResult; spend: SpendState }> {
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
    };
  }

  spend.sources.apify = recordPaidAttempt(spend.sources.apify, etDate);

  const run = (started.body as { data?: ApifyRun })?.data ?? (started.body as ApifyRun);
  if (!run?.id) {
    return {
      result: { source: "apify", paid: true, aborted: "no_run_id", points: [] },
      spend,
    };
  }

  let status = run.status;
  let datasetId = run.defaultDatasetId;
  for (let i = 0; i < 15 && !terminal(status); i += 1) {
    await sleep(4000);
    const poll = await apifyJson(token, `https://api.apify.com/v2/actor-runs/${run.id}`);
    if (isAbortHttpStatus(poll.status)) {
      spend.sources.apify = openCircuit(spend.sources.apify, etDate, `poll_${poll.status}`);
      return {
        result: { source: "apify", paid: true, aborted: `http_${poll.status}`, points: [] },
        spend,
      };
    }
    const data = (poll.body as { data?: ApifyRun })?.data;
    status = data?.status;
    datasetId = data?.defaultDatasetId ?? datasetId;
  }

  if (status !== "SUCCEEDED" || !datasetId) {
    return {
      result: { source: "apify", paid: true, aborted: status ?? "run_incomplete", points: [] },
      spend,
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
    };
  }

  const rows = (Array.isArray(items.body) ? items.body : []) as SeatGeekRow[];
  const points: MarketPoint[] = [];
  for (const row of rows) {
    if (!isHome(row)) continue;
    const date = dateFromLocal(row.datetimeLocal) ?? dateFromLocal(row.datetimeUtc);
    if (!date) continue;
    points.push({
      date,
      getIn: row.lowestPrice ?? null,
      median: row.medianPrice ?? null,
      listingCount: row.listingCount ?? null,
    });
  }

  return {
    result: { source: "apify", paid: true, points },
    spend,
  };
}
