import {
  apifyActorInput,
  canStartPaidSource,
  isAbortHttpStatus,
  isUsableCredential,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  type Flags,
  type SpendState,
} from "../../src/shared/guardrails";
import { dateFromLocal, type AdapterContext, type AdapterResult, type MarketPoint } from "./types";
import { writeSpend } from "../store";
import { reconcileSpend, reserveSpend } from "../spend";

const ACTOR = "lentic_clockss~seatgeek-scraper";
const HOME_VENUE = "capital-one-arena";

function isProviderAbortStatus(status: number): boolean {
  return status === 401 || status === 403 || isAbortHttpStatus(status);
}

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
  stats?: unknown;
};

function emptySpendResult() {
  return { actualUsd: 0, estimatedUsd: 0, reservedUsd: 0, eventsFetched: 0, pulls: 0 };
}

export function apifyInputForContext(flags: Flags, seed: boolean) {
  const baseInput = apifyActorInput(flags);
  return {
    ...baseInput,
    includeListings: seed ? false : baseInput.includeListings,
  };
}

export function apifyRunCost(
  usageTotalUsd: unknown,
  status: string | undefined,
  reservedUsd: number,
): { actualUsd: number; estimatedUsd: number } {
  const hasUsage = terminal(status) && typeof usageTotalUsd === "number"
    && Number.isFinite(usageTotalUsd) && usageTotalUsd >= 0;
  return hasUsage
    ? { actualUsd: usageTotalUsd as number, estimatedUsd: 0 }
    : { actualUsd: 0, estimatedUsd: reservedUsd };
}

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
  timeoutMs = 10_000,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
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
  const runSpend: NonNullable<AdapterResult["spend"]> = emptySpendResult();
  const gate = canStartPaidSource({
    flags,
    source: "apify",
    runPaidAttempts: 0,
    spend: spend.sources.apify,
    etDate,
    hasCredential: isUsableCredential(ctx.env.APIFY_TOKEN),
  });

  if (!gate.ok) {
    return {
      result: {
        source: "apify",
        paid: false,
        aborted: gate.reason,
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  const token = ctx.env.APIFY_TOKEN as string;
  // Seed mode always uses the inexpensive performer summary. In particular,
  // it must never inherit APIFY_INCLUDE_LISTINGS from a normal run.
  const input = apifyInputForContext(flags, ctx.seed === true);
  const reservedUsd = flags.apifyMaxTotalChargeUsd;
  const qs = new URLSearchParams({
    maxTotalChargeUsd: reservedUsd.toFixed(2),
    waitForFinish: "60",
    timeout: "180",
  });

  // Reserve the once-per-run paid source attempt before starting the actor so
  // an exception or failed response cannot leave the source eligible to retry.
  spend.sources.apify = recordPaidAttempt(spend.sources.apify, etDate);
  await writeSpend(ctx.env, spend);

  runSpend.pulls = 1;
  runSpend.reservedUsd = reservedUsd;
  const ledgerId = await reserveSpend(ctx.env, {
    source: "apify",
    etDate,
    reservedUsd,
    details: {
      kind: "actor_run",
      actor: ACTOR,
      maxTotalChargeUsd: reservedUsd,
      includeListings: input.includeListings,
      seed: ctx.seed === true,
    },
  });

  let latestRun: ApifyRun | undefined;
  // Apify's first terminal response can contain preliminary usage. The
  // delayed GET below is the billing confirmation used for actual spend.
  let billingUsage: unknown;
  let finalized = false;
  const finishLedger = async (details: Record<string, unknown> = {}) => {
    if (finalized) return;
    finalized = true;
    latestRun = latestRun ?? undefined;
    const usage = billingUsage;
    const providerStatus = latestRun?.status;
    const cost = apifyRunCost(usage, providerStatus, reservedUsd);
    const hasUsage = cost.actualUsd > 0 || (terminal(providerStatus) && usage === 0);
    runSpend.actualUsd = cost.actualUsd;
    // Actual and estimated are disjoint: after Apify exposes usage, the
    // reservation remains visible as the cap but is no longer an estimate.
    runSpend.estimatedUsd = cost.estimatedUsd;
    runSpend.runId = latestRun?.id;
    runSpend.status = details.status as string | undefined ?? latestRun?.status;
    runSpend.stats = latestRun?.stats;
    try {
      await reconcileSpend(ctx.env, ledgerId, {
        actualUsd: runSpend.actualUsd,
        estimatedUsd: runSpend.estimatedUsd,
        details: {
          ...details,
          runId: latestRun?.id,
          status: details.status ?? latestRun?.status,
          providerStatus,
          usageTotalUsd: hasUsage ? usage : undefined,
          stats: latestRun?.stats,
          eventsFetched: runSpend.eventsFetched,
          pulls: runSpend.pulls,
        },
      });
    } catch {
      // The reservation itself is durable. If reconciliation is temporarily
      // unavailable, admin will continue to show the conservative estimate.
    }
  };

  const result = (
    paid: boolean,
    points: MarketPoint[],
    aborted?: string,
  ): AdapterResult => ({
    source: "apify",
    paid,
    aborted,
    points,
    spend: { ...runSpend },
  });

  try {
    const started = await apifyJson(
      token,
      `https://api.apify.com/v2/actors/${ACTOR}/runs?${qs}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      70_000,
    );

    if (isProviderAbortStatus(started.status)) {
      spend.sources.apify = openCircuit(spend.sources.apify, etDate, `start_${started.status}`);
      await finishLedger({ status: `http_${started.status}` });
      return { result: result(false, [], `http_${started.status}`), spend };
    }

    if (started.status < 200 || started.status >= 300) {
      await finishLedger({ status: `http_${started.status}` });
      return { result: result(false, [], `start_${started.status}`), spend };
    }

    const run = (started.body as { data?: ApifyRun })?.data ?? (started.body as ApifyRun);
    latestRun = run;
    if (!run?.id) {
      await finishLedger({ status: "no_run_id" });
      return { result: result(true, [], "no_run_id"), spend };
    }

    let status = run.status;
    let datasetId = run.defaultDatasetId;
    for (let i = 0; i < 15 && !terminal(status); i += 1) {
      await sleep(4000);
      const poll = await apifyJson(token, `https://api.apify.com/v2/actor-runs/${run.id}`);
      if (isProviderAbortStatus(poll.status)) {
        spend.sources.apify = openCircuit(spend.sources.apify, etDate, `poll_${poll.status}`);
        await finishLedger({ status: `http_${poll.status}` });
        return { result: result(true, [], `http_${poll.status}`), spend };
      }
      const data = (poll.body as { data?: ApifyRun })?.data;
      if (data) latestRun = data;
      status = data?.status ?? status;
      datasetId = data?.defaultDatasetId ?? datasetId;
    }

    if (status !== "SUCCEEDED" || !datasetId) {
      await finishLedger({ status: status ?? "run_incomplete" });
      return { result: result(true, [], status ?? "run_incomplete"), spend };
    }

    // The actor run endpoint documents usageTotalUsd as settling shortly
    // after completion. One delayed read makes the ledger actual when the
    // provider exposes it, while still leaving a conservative reservation if
    // the billing read is unavailable.
    try {
      await sleep(10_000);
      const settled = await apifyJson(token, `https://api.apify.com/v2/actor-runs/${run.id}`);
      if (settled.status >= 200 && settled.status < 300) {
        const settledRun = (settled.body as { data?: ApifyRun })?.data;
        if (settledRun) {
          latestRun = settledRun;
          billingUsage = settledRun.usageTotalUsd;
          status = settledRun.status ?? status;
          datasetId = settledRun.defaultDatasetId ?? datasetId;
        }
      }
    } catch {
      billingUsage = undefined;
    }

    if (status !== "SUCCEEDED" || !datasetId) {
      await finishLedger({ status: status ?? "run_incomplete" });
      return { result: result(true, [], status ?? "run_incomplete"), spend };
    }

    const items = await apifyJson(
      token,
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&limit=${flags.apifyMaxEvents}`,
    );
    if (isProviderAbortStatus(items.status)) {
      spend.sources.apify = openCircuit(spend.sources.apify, etDate, `items_${items.status}`);
      await finishLedger({ status: `http_${items.status}`, datasetId });
      return { result: result(true, [], `http_${items.status}`), spend };
    }
    if (items.status < 200 || items.status >= 300) {
      await finishLedger({ status: `http_${items.status}`, datasetId });
      return { result: result(true, [], `http_${items.status}`), spend };
    }

    const rows = (Array.isArray(items.body) ? items.body : []) as SeatGeekRow[];
    runSpend.eventsFetched = rows.length;
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

    await finishLedger({ status: "SUCCEEDED", datasetId });
    return { result: result(true, points), spend };
  } catch {
    spend.sources.apify = openCircuit(spend.sources.apify, etDate, "request_failed");
    await finishLedger({ status: "request_failed" });
    return { result: result(true, [], "request_failed"), spend };
  }
}
