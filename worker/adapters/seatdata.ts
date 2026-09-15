import {
  extractSectionNumber,
  formatEtStamp,
  goingAskFromListings,
  isCompListing,
  normalizeRow,
  type CompListing,
  type MarketDetails,
  type MarketZoneComp,
} from "../../src/shared/book";
import {
  canStartPaidSource,
  canTakeSeatDataPull,
  etDateFrom,
  isAbortHttpStatus,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  recordSeatDataPull,
  isUsableCredential,
  type Flags,
  type SpendState,
} from "../../src/shared/guardrails";
import type { AdapterContext, AdapterResult, MarketPoint } from "./types";
import { writeSpend } from "../store";
import { reconcileSpend, reserveSpend } from "../spend";

const SEATDATA_PULL_USD = 0.04;

function isProviderAbortStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || isAbortHttpStatus(status);
}

function emptySpendResult() {
  return { actualUsd: 0, estimatedUsd: 0, reservedUsd: 0, eventsFetched: 0, pulls: 0 };
}

export function seatDataCaps(seed: boolean, flags: Flags): {
  maxPerRun: number;
  maxPerDay: number;
} {
  return seed
    ? { maxPerRun: 50, maxPerDay: 100 }
    : { maxPerRun: flags.seatdataMaxPullsPerRun, maxPerDay: flags.seatdataMaxPullsPerEtDay };
}

export function seatDataPullCost(hasRefreshed: unknown): {
  actualUsd: number;
  estimatedUsd: number;
} {
  if (hasRefreshed === 0 || hasRefreshed === 1) {
    return { actualUsd: hasRefreshed * SEATDATA_PULL_USD, estimatedUsd: 0 };
  }
  return { actualUsd: 0, estimatedUsd: SEATDATA_PULL_USD };
}

type SearchEvent = {
  event_id?: number;
  event_date?: string;
  event_name?: string;
  performer?: string;
  venue_name?: string;
  venue_slug?: string;
};

type PricedListing = {
  section: string | null;
  row: string | null;
  quantity: number;
  price: number;
};

function isActivePairListing(listing: CompListing): boolean {
  const active = listing.active === true || listing.active === 1;
  const quantity = listing.quantity;
  const price = listing.price;
  return (
    active &&
    typeof quantity === "number" &&
    Number.isFinite(quantity) &&
    quantity >= 2 &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0
  );
}

function pricedListing(listing: CompListing): PricedListing | null {
  if (!isActivePairListing(listing)) return null;
  return {
    section: extractSectionNumber(listing.section),
    row: normalizeRow(listing.row),
    quantity: listing.quantity as number,
    price: listing.price as number,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return Math.round(value * 100) / 100;
}

/**
 * Derive market detail metrics from the listings response already fetched for
 * a SeatData event. This function is pure so extraction can be tested without
 * making a provider request (or spending a pull).
 */
export function marketDetailsFromListings(
  listings: CompListing[],
  asof: string,
): MarketDetails {
  const eligible = listings
    .map(pricedListing)
    .filter((listing): listing is PricedListing => listing != null);
  const allPrices = eligible.map((listing) => listing.price);
  const lowerLevelPrices = eligible
    .filter((listing) => {
      const sectionNumber = listing.section ? Number(listing.section) : NaN;
      return Number.isInteger(sectionNumber) && sectionNumber >= 100 && sectionNumber <= 199;
    })
    .map((listing) => listing.price);
  const zoneListings = listings
    .filter(isCompListing)
    .map(pricedListing)
    .filter((listing): listing is PricedListing => listing != null && listing.section != null && listing.row != null)
    .sort((a, b) => a.price - b.price || a.section!.localeCompare(b.section!) || a.row!.localeCompare(b.row!));
  const zoneComps: MarketZoneComp[] = zoneListings.map((listing) => ({
    section: listing.section as string,
    row: listing.row as string,
    quantity: listing.quantity,
    price: listing.price,
  }));

  return {
    source: "seatdata",
    asof,
    get_in: allPrices.length > 0 ? Math.round(Math.min(...allPrices) * 100) / 100 : null,
    median: median(allPrices),
    lower_level_get_in: lowerLevelPrices.length > 0
      ? Math.round(Math.min(...lowerLevelPrices) * 100) / 100
      : null,
    lower_level_median: median(lowerLevelPrices),
    zone_get_in: zoneComps.length > 0 ? zoneComps[0].price : null,
    zone_median: median(zoneComps.map((listing) => listing.price)),
    zone_comp_count: zoneComps.length,
    // Keep the durable detail payload bounded while retaining the full count
    // and aggregate metrics above.
    zone_comps: zoneComps.slice(0, 50),
  };
}

function homeEvent(event: SearchEvent): boolean {
  const venue = `${event.venue_name ?? ""} ${event.venue_slug ?? ""}`.toLowerCase();
  return venue.includes("capital one") || venue.includes("capital-one-arena");
}

function wizardsEvent(event: SearchEvent): boolean {
  const name = `${event.event_name ?? ""} ${event.performer ?? ""}`.toLowerCase();
  return name.includes("wizard");
}

async function seatdataFetch(
  env: Env,
  path: string,
  query: Record<string, string>,
): Promise<Response> {
  const flags = parseFlags(env);
  const url = new URL(path.replace(/^\//, ""), `${flags.seatdataBaseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.SEATDATA_API_KEY ?? ""}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
}

function snapshotDate(asof: string | null | undefined): string | null {
  const match = asof?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function rotateDates(dates: string[], cursor: string | null | undefined): string[] {
  if (!cursor || dates.length < 2) return dates;
  const cursorIndex = dates.indexOf(cursor);
  if (cursorIndex < 0) return dates;
  return [...dates.slice(cursorIndex + 1), ...dates.slice(0, cursorIndex + 1)];
}

function prioritizeDates(
  games: AdapterContext["games"],
  now: Date,
  rotationCursor?: string | null,
  seed = false,
): string[] {
  const today = etDateFrom(now);
  const eligible = [...games].filter(
    (game) => {
      if (game.date < today) return false;
      if (!seed && game.sit_or_sell === "TBD") return false;
      // A seed run may span multiple invocations, so do not spend another
      // pull on a game already refreshed today. This leaves the larger seed
      // budget for the homes still missing a current observation.
      if (seed && snapshotDate(game.market_details?.asof) === today) return false;
      return true;
    },
  );
  const missingDetails = eligible
    .filter((game) => game.market_details == null)
    .sort((a, b) => {
      const dateOrder = a.date.localeCompare(b.date);
      if (dateOrder !== 0) return dateOrder;
      return (a.sit_or_sell === "Sell" ? 0 : 1) - (b.sit_or_sell === "Sell" ? 0 : 1);
    });
  const withDetails = eligible
    .filter((game) => game.market_details != null)
    .sort((a, b) => {
      const aSnapshot = snapshotDate(a.market_details?.asof) ?? "9999-99-99";
      const bSnapshot = snapshotDate(b.market_details?.asof) ?? "9999-99-99";
      const snapshotOrder = aSnapshot.localeCompare(bSnapshot);
      if (snapshotOrder !== 0) return snapshotOrder;
      const dateOrder = a.date.localeCompare(b.date);
      if (dateOrder !== 0) return dateOrder;
      return (a.sit_or_sell === "Sell" ? 0 : 1) - (b.sit_or_sell === "Sell" ? 0 : 1);
    });

  // Keep missing snapshots strictly first and rotate only ties among games
  // with the same snapshot date. This preserves oldest-snapshot priority while
  // allowing a capped run to reach games after the first 20 on later runs.
  const rotatedDetails: string[] = [];
  let index = 0;
  while (index < withDetails.length) {
    const snapshot = snapshotDate(withDetails[index].market_details?.asof) ?? "9999-99-99";
    let end = index + 1;
    while (end < withDetails.length) {
      const nextSnapshot = snapshotDate(withDetails[end].market_details?.asof) ?? "9999-99-99";
      if (nextSnapshot !== snapshot) break;
      end += 1;
    }
    rotatedDetails.push(...rotateDates(withDetails.slice(index, end).map((game) => game.date), rotationCursor));
    index = end;
  }
  return [...missingDetails.map((game) => game.date), ...rotatedDetails];
}

export async function runSeatData(
  ctx: AdapterContext,
  spend: SpendState,
  etDate: string,
): Promise<{ result: AdapterResult; spend: SpendState }> {
  const flags = parseFlags(ctx.env);
  const caps = seatDataCaps(ctx.seed === true, flags);
  const maxPullsPerRun = caps.maxPerRun;
  const maxPullsPerEtDay = caps.maxPerDay;
  const runSpend: NonNullable<AdapterResult["spend"]> = emptySpendResult();
  const gate = canStartPaidSource({
    flags,
    source: "seatdata",
    runPaidAttempts: 0,
    spend: spend.sources.seatdata,
    etDate,
    hasCredential: isUsableCredential(ctx.env.SEATDATA_API_KEY),
  });

  if (!gate.ok) {
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: gate.reason,
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  // Avoid even the paid search request when the ET-day pull budget is already
  // exhausted. The listing gate below remains in place for each individual
  // event pull and still enforces both hard caps.
  const dayGate = canTakeSeatDataPull({
    runPulls: 0,
    pullsToday: spend.sources.seatdata.pullsToday,
    maxPerRun: maxPullsPerRun,
    maxPerDay: maxPullsPerEtDay,
  });
  if (!dayGate.ok && dayGate.reason === "day_pull_cap") {
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: dayGate.reason,
        pulls: 0,
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  // Reserve the once-per-run paid source attempt before making the request so
  // an exception or failed response cannot leave the source eligible to retry.
  spend.sources.seatdata = recordPaidAttempt(spend.sources.seatdata, etDate);
  await writeSpend(ctx.env, spend);

  let search: Response;
  try {
    search = await seatdataFetch(ctx.env, "/v1/events/search", {
      venue_name: "Capital One Arena",
      event_name: "Washington Wizards",
      limit: "200",
    });
  } catch {
    spend.sources.seatdata = openCircuit(spend.sources.seatdata, etDate, "search_request_failed");
    runSpend.status = "search_request_failed";
    return {
      result: {
        source: "seatdata",
        paid: true,
        aborted: "request_failed",
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  if (isProviderAbortStatus(search.status)) {
    runSpend.status = `http_${search.status}`;
    spend.sources.seatdata = openCircuit(
      spend.sources.seatdata,
      etDate,
      `search_${search.status}`,
    );
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: `http_${search.status}`,
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  if (!search.ok) {
    runSpend.status = `http_${search.status}`;
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: `search_${search.status}`,
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }

  let payload: { data?: SearchEvent[] };
  try {
    payload = (await search.json()) as { data?: SearchEvent[] };
  } catch {
    spend.sources.seatdata = openCircuit(spend.sources.seatdata, etDate, "search_invalid_json");
    runSpend.status = "search_invalid_json";
    return {
      result: {
        source: "seatdata",
        paid: true,
        aborted: "invalid_json",
        points: [],
        spend: runSpend,
      },
      spend,
    };
  }
  const events = (payload.data ?? []).filter(
    (event) => homeEvent(event) && wizardsEvent(event) && event.event_id && event.event_date,
  );
  const byDate = new Map<string, SearchEvent>();
  for (const event of events) {
    if (event.event_date && !byDate.has(event.event_date)) {
      byDate.set(event.event_date, event);
    }
  }

  let runPulls = 0;
  const points: MarketPoint[] = [];
  const dates = prioritizeDates(
    ctx.games,
    ctx.now,
    spend.sources.seatdata.rotationCursor,
    ctx.seed === true,
  );

  for (const date of dates) {
    const event = byDate.get(date);
    if (!event?.event_id) continue;

    const pullGate = canTakeSeatDataPull({
      runPulls,
      pullsToday: spend.sources.seatdata.pullsToday,
      maxPerRun: maxPullsPerRun,
      maxPerDay: maxPullsPerEtDay,
    });
    if (!pullGate.ok) break;

    // Reserve the per-run and per-ET-day pull before the paid request. This is
    // intentionally conservative when the provider fails or times out.
    runPulls += 1;
    runSpend.pulls = runPulls;
    runSpend.reservedUsd += SEATDATA_PULL_USD;
    spend.sources.seatdata = recordSeatDataPull(spend.sources.seatdata, etDate);
    spend.sources.seatdata.rotationCursor = date;
    await writeSpend(ctx.env, spend);

    const ledgerId = await reserveSpend(ctx.env, {
      source: "seatdata",
      etDate,
      reservedUsd: SEATDATA_PULL_USD,
      details: { gameDate: date, eventId: event.event_id, seed: ctx.seed === true },
    });

    let listingsRes: Response;
    try {
      listingsRes = await seatdataFetch(ctx.env, "/v0.1.1/listings/get", {
        event_id: String(event.event_id),
      });
    } catch {
      spend.sources.seatdata = openCircuit(spend.sources.seatdata, etDate, "request_failed");
      runSpend.estimatedUsd += SEATDATA_PULL_USD;
      const status = "request_failed";
      runSpend.status = status;
      await reconcileSpend(ctx.env, ledgerId, {
        actualUsd: 0,
        estimatedUsd: SEATDATA_PULL_USD,
        details: { status: "request_failed", eventsFetched: 0 },
      });
      return {
        result: {
          source: "seatdata",
          paid: true,
          aborted: "request_failed",
          pulls: runPulls,
          points,
          spend: { ...runSpend },
        },
        spend,
      };
    }

    if (isProviderAbortStatus(listingsRes.status)) {
      runSpend.estimatedUsd += SEATDATA_PULL_USD;
      runSpend.status = `http_${listingsRes.status}`;
      await reconcileSpend(ctx.env, ledgerId, {
        actualUsd: 0,
        estimatedUsd: SEATDATA_PULL_USD,
        details: { status: `http_${listingsRes.status}`, eventsFetched: 0 },
      });
      spend.sources.seatdata = openCircuit(
        spend.sources.seatdata,
        etDate,
        `listings_${listingsRes.status}`,
      );
      return {
        result: {
          source: "seatdata",
          paid: true,
          aborted: `http_${listingsRes.status}`,
          pulls: runPulls,
          points,
          spend: { ...runSpend },
        },
        spend,
      };
    }

    if (!listingsRes.ok) {
      runSpend.estimatedUsd += SEATDATA_PULL_USD;
      runSpend.status = `http_${listingsRes.status}`;
      await reconcileSpend(ctx.env, ledgerId, {
        actualUsd: 0,
        estimatedUsd: SEATDATA_PULL_USD,
        details: { status: `http_${listingsRes.status}`, eventsFetched: 0 },
      });
      continue;
    }

    let body: { has_refreshed?: number; listings?: CompListing[] };
    try {
      body = (await listingsRes.json()) as {
        has_refreshed?: number;
        listings?: CompListing[];
      };
    } catch {
      runSpend.estimatedUsd += SEATDATA_PULL_USD;
      runSpend.status = "invalid_json";
      await reconcileSpend(ctx.env, ledgerId, {
        actualUsd: 0,
        estimatedUsd: SEATDATA_PULL_USD,
        details: { status: "invalid_json", eventsFetched: 0 },
      });
      continue;
    }
    const listings = body.listings ?? [];
    const refreshed = body.has_refreshed === 1 || body.has_refreshed === 0
      ? body.has_refreshed
      : null;
    // `has_refreshed` is the provider's billing signal. Once it is present,
    // the amount is actual and no longer belongs in the estimate bucket.
    const { actualUsd, estimatedUsd } = seatDataPullCost(refreshed);
    runSpend.eventsFetched += 1;
    runSpend.actualUsd += actualUsd;
    runSpend.estimatedUsd += estimatedUsd;
    runSpend.status = "succeeded";
    await reconcileSpend(ctx.env, ledgerId, {
      actualUsd,
      estimatedUsd,
      details: {
        status: "succeeded",
        hasRefreshed: body.has_refreshed,
        eventsFetched: 1,
        listingCount: listings.length,
      },
    });
    const ask = goingAskFromListings(listings);
    // The details snapshot is derived from this same response. It must not
    // trigger another request, including when the response has no usable
    // listings; an empty snapshot is still useful to distinguish "pulled"
    // from "not pulled" in the book UI.
    points.push({
      date,
      advisedAsk: ask,
      marketDetails: marketDetailsFromListings(listings, formatEtStamp(ctx.now)),
    });
  }

  return {
    result: {
      source: "seatdata",
      paid: true,
      pulls: runPulls,
      points,
      spend: { ...runSpend },
    },
    spend,
  };
}
