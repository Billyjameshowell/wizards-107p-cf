import { type CompListing } from "../../src/shared/book";
import type { ObservedPull } from "../../src/shared/archive";
import { orderGamesForCompPull } from "../../src/shared/price-history";
import { seriousCompMedian } from "../../src/shared/pricing";
import {
  canStartPaidSource,
  canTakeSeatDataPull,
  isAbortHttpStatus,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  recordSeatDataPull,
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
): Promise<{ result: AdapterResult; spend: SpendState; observations: ObservedPull[] }> {
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
  }

  return {
    result: { source: "seatdata", paid: true, pulls: runPulls, points },
    spend,
    observations,
  };
}
