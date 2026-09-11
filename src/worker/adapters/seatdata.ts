import {
  goingAskFromListings,
  type CompListing,
} from "@shared/book";
import {
  canStartPaidSource,
  canTakeSeatDataPull,
  isAbortHttpStatus,
  openCircuit,
  parseFlags,
  recordPaidAttempt,
  recordSeatDataPull,
  type SpendState,
} from "@shared/guardrails";
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

async function seatdataFetch(
  env: Env,
  path: string,
  query: Record<string, string>,
): Promise<Response> {
  const flags = parseFlags(env);
  const url = new URL(path, `${flags.seatdataBaseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.SEATDATA_API_KEY ?? ""}`,
      Accept: "application/json",
    },
  });
}

function prioritizeDates(games: AdapterContext["games"], now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  return [...games]
    .filter((game) => game.date >= today && game.sit_or_sell !== "TBD")
    .sort((a, b) => {
      const aNeed = a.advised_ask == null ? 0 : 1;
      const bNeed = b.advised_ask == null ? 0 : 1;
      if (aNeed !== bNeed) return aNeed - bNeed;
      const aSell = a.sit_or_sell === "Sell" ? 0 : 1;
      const bSell = b.sit_or_sell === "Sell" ? 0 : 1;
      if (aSell !== bSell) return aSell - bSell;
      return a.date.localeCompare(b.date);
    })
    .map((game) => game.date);
}

export async function runSeatData(
  ctx: AdapterContext,
  spend: SpendState,
  etDate: string,
): Promise<{ result: AdapterResult; spend: SpendState }> {
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
    };
  }

  const search = await seatdataFetch(ctx.env, "/v1/events/search", {
    venue_name: "Capital One Arena",
    event_name: "Washington Wizards",
    limit: "200",
  });

  if (isAbortHttpStatus(search.status)) {
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
    };
  }

  if (!search.ok) {
    return {
      result: {
        source: "seatdata",
        paid: false,
        aborted: `search_${search.status}`,
        points: [],
      },
      spend,
    };
  }

  const payload = (await search.json()) as { data?: SearchEvent[] };
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
    if (!event?.event_id) continue;

    const pullGate = canTakeSeatDataPull({
      runPulls,
      pullsToday: spend.sources.seatdata.pullsToday,
      maxPerRun: flags.seatdataMaxPullsPerRun,
      maxPerDay: flags.seatdataMaxPullsPerEtDay,
    });
    if (!pullGate.ok) break;

    const listingsRes = await seatdataFetch(ctx.env, "/v0.1.1/listings/get", {
      event_id: String(event.event_id),
    });

    if (isAbortHttpStatus(listingsRes.status)) {
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
        },
        spend,
      };
    }

    if (!listingsRes.ok) continue;

    const body = (await listingsRes.json()) as {
      has_refreshed?: number;
      listings?: CompListing[];
    };
    if (body.has_refreshed === 1) {
      runPulls += 1;
      spend.sources.seatdata = recordSeatDataPull(spend.sources.seatdata, etDate);
    }

    const ask = goingAskFromListings(body.listings ?? []);
    if (ask != null) {
      points.push({ date, advisedAsk: ask });
    }
  }

  return {
    result: { source: "seatdata", paid: true, pulls: runPulls, points },
    spend,
  };
}
