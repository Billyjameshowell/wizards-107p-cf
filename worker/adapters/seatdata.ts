import { extractSectionNumber, isCompListing, normalizeRow, type CompListing } from "../../src/shared/book";
import type { ObservedPull } from "../../src/shared/archive";
import { orderGamesForCompPull } from "../../src/shared/price-history";
import type { ProbableSale } from "../../src/shared/price-model";
import { daysUntil, seriousCompMedian } from "../../src/shared/pricing";
import {
  canStartPaidSource,
  canTakeSeatDataPull,
  isAbortHttpStatus,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  recordSeatDataPull,
  type Flags,
  type SpendState,
} from "../../src/shared/guardrails";
import type { AdapterContext, AdapterResult, MarketPoint } from "./types";

type SearchEvent = {
  event_id?: number;
  event_date?: string;
  event_name?: string;
  performer?: string;
  venue_name?: string;
  venue_slug?: string;
};

function homeEvent(event: SearchEvent): boolean {
  const venue = `${event.venue_name ?? ""} ${event.venue_slug ?? ""}`.toLowerCase();
  return venue.includes("capital one") || venue.includes("capital-one-arena");
}

function wizardsEvent(event: SearchEvent): boolean {
  const name = `${event.event_name ?? ""} ${event.performer ?? ""}`.toLowerCase();
  return name.includes("wizard");
}

/** Build a SeatData absolute URL. Base is origin only (e.g. https://seatdata.io). */
export function buildSeatdataUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> = {},
): string {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function seatdataFetch(
  env: Env,
  path: string,
  query: Record<string, string>,
): Promise<Response> {
  const flags = parseFlags(env);
  const url = buildSeatdataUrl(flags.seatdataBaseUrl, path, query);
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${env.SEATDATA_API_KEY ?? ""}`,
      Accept: "application/json",
    },
  });
}

export function prioritizeDates(games: AdapterContext["games"], now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const open = games.filter((game) => game.date >= today && game.sit_or_sell !== "TBD");
  return orderGamesForCompPull(open, now).map((game) => game.date);
}

function opponentFor(ctx: AdapterContext, date: string): string | null {
  return ctx.games.find((game) => game.date === date)?.opponent ?? null;
}

export async function runSeatData(
  ctx: AdapterContext,
  spend: SpendState,
  etDate: string,
): Promise<{ result: AdapterResult; spend: SpendState; observations: ObservedPull[]; sales: ProbableSale[] }> {
  const flags = parseFlags(ctx.env);
  const gate = canStartPaidSource({
    flags,
    source: "seatdata",
    runPaidAttempts: 0,
    spend: spend.sources.seatdata,
    etDate,
    hasCredential: Boolean(ctx.env.SEATDATA_API_KEY),
  });

  if (!gate.ok) {
    return {
      result: { source: "seatdata", paid: false, aborted: gate.reason, points: [] },
      spend,
      observations: [],
      sales: [],
    };
  }

  const search = await seatdataFetch(ctx.env, "/api/v1/events/search", {
    venue_name: "Capital One Arena",
    event_name: "Washington Wizards",
    limit: "200",
  });

  if (isAbortHttpStatus(search.status)) {
    await search.body?.cancel();
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
      },
      spend,
      observations: [
        {
          gameDate: null,
          status: "failed",
          paid: false,
          httpStatus: search.status,
          error: `http_${search.status}`,
          note: "event search",
        },
      ],
      sales: [],
    };
  }

  if (!search.ok) {
    await search.body?.cancel();
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: `search_${search.status}`,
        points: [],
      },
      spend,
      observations: [
        {
          gameDate: null,
          status: "failed",
          paid: false,
          httpStatus: search.status,
          error: `search_${search.status}`,
          note: "event search",
        },
      ],
      sales: [],
    };
  }

  const payload = (await search.json()) as { data?: SearchEvent[] };
  const observations: ObservedPull[] = [
    {
      gameDate: null,
      status: "ok",
      paid: false,
      httpStatus: search.status,
      note: "event search",
      raw: payload,
      listingCount: 0,
    },
  ];
  const events = (payload.data ?? []).filter(
    (event) => homeEvent(event) && wizardsEvent(event) && event.event_id && event.event_date,
  );
  const byDate = new Map<string, SearchEvent>();
  for (const event of events) {
    if (event.event_date && !byDate.has(event.event_date)) {
      byDate.set(event.event_date, event);
    }
  }

  spend.sources.seatdata = recordPaidAttempt(spend.sources.seatdata, etDate);

  let runPulls = 0;
  const points: MarketPoint[] = [];
  const sales: ProbableSale[] = [];
  const dates = prioritizeDates(ctx.games, ctx.now);

  for (const date of dates) {
    const event = byDate.get(date);
    // No event yet: leave the game at "No price yet" and do not spend a pull.
    // The next run that sees the event can fill it, because unchecked games go first.
    if (!event?.event_id) continue;

    const pullGate = canTakeSeatDataPull({
      runPulls,
      pullsToday: spend.sources.seatdata.pullsToday,
      maxPerRun: flags.seatdataMaxPullsPerRun,
      maxPerDay: flags.seatdataMaxPullsPerEtDay,
    });
    if (!pullGate.ok) {
      observations.push({
        gameDate: null,
        status: "skipped",
        paid: false,
        error: pullGate.reason,
        note: "seatdata pull cap",
      });
      break;
    }

    const listingsRes = await seatdataFetch(ctx.env, "/api/v0.1.1/listings/get", {
      event_id: String(event.event_id),
    });

    if (isAbortHttpStatus(listingsRes.status)) {
      await listingsRes.body?.cancel();
      spend.sources.seatdata = openCircuit(
        spend.sources.seatdata,
        etDate,
        `listings_${listingsRes.status}`,
      );
      observations.push({
        gameDate: date,
        opponent: opponentFor(ctx, date),
        status: "failed",
        paid: true,
        httpStatus: listingsRes.status,
        error: `http_${listingsRes.status}`,
      });
      return {
        result: {
          source: "seatdata",
          paid: true,
          aborted: `http_${listingsRes.status}`,
          pulls: runPulls,
          points,
        },
        spend,
        observations,
        sales,
      };
    }

    if (!listingsRes.ok) {
      await listingsRes.body?.cancel();
      observations.push({
        gameDate: date,
        opponent: opponentFor(ctx, date),
        status: "failed",
        paid: false,
        httpStatus: listingsRes.status,
        error: `listings_${listingsRes.status}`,
      });
      continue;
    }

    const body = (await listingsRes.json()) as {
      has_refreshed?: number;
      listings?: CompListing[];
    };
    if (body.has_refreshed === 1) {
      runPulls += 1;
      spend.sources.seatdata = recordSeatDataPull(spend.sources.seatdata, etDate);
    }

    // listing.price has no all-in flag in this client. The middle is stored as
    // “listed around” and the page turns it into you-keep with the 5% seller fee only.
    const listings = body.listings ?? [];
    const snapshot = seriousCompMedian(listings);
    points.push({
      date,
      compMedian: snapshot.median,
      compCount: snapshot.count,
      compExcludedDump: snapshot.excludedDump,
    });
    observations.push({
      gameDate: date,
      opponent: opponentFor(ctx, date),
      status: listings.length === 0 ? "empty" : "ok",
      paid: body.has_refreshed === 1,
      httpStatus: listingsRes.status,
      listings,
      raw: body,
      median: snapshot.median,
      compCount: snapshot.count,
      excludedDump: snapshot.excludedDump,
      listingCount: listings.length,
    });

    if (flags.seatdataFetchSales) {
      const fetched = await fetchRecentSales({
        env: ctx.env,
        eventId: event.event_id,
        gameDate: date,
        now: ctx.now,
        runPulls,
        spend,
        etDate,
        flags,
      });
      runPulls = fetched.runPulls;
      spend = fetched.spend;
      sales.push(...fetched.sales);
      if (fetched.aborted) {
        return {
          result: {
            source: "seatdata",
            paid: true,
            aborted: fetched.aborted,
            pulls: runPulls,
            points,
          },
          spend,
          observations,
          sales,
        };
      }
    }
  }

  return {
    result: { source: "seatdata", paid: true, pulls: runPulls, points },
    spend,
    observations,
    sales,
  };
}

/**
 * One page of recent sales for an event. Off unless the flag is on.
 * An empty response is free. A response that has sale rows spends one pull,
 * inside the same per-run and per-day caps as listings.
 */
async function fetchRecentSales(args: {
  env: Env;
  eventId: number;
  gameDate: string;
  now: Date;
  runPulls: number;
  spend: SpendState;
  etDate: string;
  flags: Flags;
}): Promise<{ sales: ProbableSale[]; runPulls: number; spend: SpendState; aborted?: string }> {
  const pullGate = canTakeSeatDataPull({
    runPulls: args.runPulls,
    pullsToday: args.spend.sources.seatdata.pullsToday,
    maxPerRun: args.flags.seatdataMaxPullsPerRun,
    maxPerDay: args.flags.seatdataMaxPullsPerEtDay,
  });
  if (!pullGate.ok) return { sales: [], runPulls: args.runPulls, spend: args.spend };

  const response = await seatdataFetch(args.env, `/v1/events/${args.eventId}/sales`, { source: "all" });
  if (isAbortHttpStatus(response.status)) {
    await response.body?.cancel();
    args.spend.sources.seatdata = openCircuit(args.spend.sources.seatdata, args.etDate, `sales_${response.status}`);
    return { sales: [], runPulls: args.runPulls, spend: args.spend, aborted: `http_${response.status}` };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { sales: [], runPulls: args.runPulls, spend: args.spend };
  }

  const body = (await response.json()) as { data?: unknown[]; sales?: unknown[] };
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.sales) ? body.sales : [];
  const parsed = rows.slice(0, 80).flatMap((row) => readSale(row, args.gameDate, args.eventId, args.now));
  let runPulls = args.runPulls;
  // A response with sale rows spends one pull, even if none are in the pair band.
  if (rows.length > 0) {
    runPulls += 1;
    args.spend.sources.seatdata = recordSeatDataPull(args.spend.sources.seatdata, args.etDate);
  }
  return { sales: parsed, runPulls, spend: args.spend };
}

function readSale(value: unknown, gameDate: string, eventId: number, now: Date): ProbableSale[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const price = numberOf(row.price ?? row.sale_price ?? row.amount);
  const quantity = numberOf(row.quantity ?? row.qty);
  const section = typeof row.section === "string" ? row.section : undefined;
  const rowName = typeof row.row === "string" ? row.row : undefined;
  if (
    price == null ||
    quantity == null ||
    !isCompListing({ active: true, section, row: rowName, quantity, price })
  ) {
    return [];
  }
  const stamp = typeof row.purchased_at === "string" ? row.purchased_at : typeof row.sold_at === "string" ? row.sold_at : "";
  const day = /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : now.toISOString().slice(0, 10);
  const daysOut = daysUntil(gameDate, day) ?? 0;
  const rawId = row.id ?? row.sale_id ?? `${section}|${rowName}|${quantity}|${Math.round(price * 100)}|${day}`;
  return [
    {
      gameDate,
      seenDate: day,
      goneDate: day,
      daysOut,
      section: extractSectionNumber(section) ?? "",
      row: normalizeRow(rowName) ?? "",
      quantity,
      price,
      certain: true,
      externalId: `sale|${eventId}|${String(rawId).slice(0, 120)}`,
      median: null,
      supply: null,
    },
  ];
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
