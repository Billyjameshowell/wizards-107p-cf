import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySpendState } from "@shared/guardrails";
import type { Game } from "@shared/book";

const { writeSpendMock } = vi.hoisted(() => ({ writeSpendMock: vi.fn() }));
vi.mock("../worker/store", () => ({ writeSpend: writeSpendMock }));

import { marketDetailsFromListings, runSeatData } from "../worker/adapters/seatdata";
import { runApify } from "../worker/adapters/apify";

const now = new Date("2026-09-15T15:00:00.000Z");

function games(count: number): Game[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    weekday: "Thursday",
    time_et: "7:00 PM",
    opponent: "Washington Wizards",
    type: "Regular Season",
    sit_or_sell: "Sell",
    advised_ask: null,
    cash_both_after_fee: null,
    listed: false,
    listed_ask: null,
    sold: false,
    notes: "",
    ticketdata_url: null,
  }));
}

function env(overrides: Record<string, string> = {}): Env {
  return {
    INGEST_ENABLED: "true",
    DRY_RUN: "false",
    SOURCES: "seatdata",
    SEATDATA_API_KEY: "real-seatdata-token",
    SEATDATA_BASE_URL: "https://seatdata.io/api",
    ...overrides,
  } as unknown as Env;
}

function searchBody(count: number): { data: Array<Record<string, unknown>> } {
  return {
    data: games(count).map((game, index) => ({
      event_id: index + 1,
      event_date: game.date,
      event_name: "Washington Wizards",
      performer: "Washington Wizards",
      venue_name: "Capital One Arena",
    })),
  };
}

function details(asof: string) {
  return {
    source: "seatdata" as const,
    asof,
    get_in: 100,
    median: 120,
    lower_level_get_in: null,
    lower_level_median: null,
    zone_get_in: null,
    zone_median: null,
    zone_comp_count: 0,
    zone_comps: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeSpendMock.mockReset();
});

describe("SeatData adapter guardrails", () => {
  it("extracts all, lower-level, and configured-zone metrics from one listings response", () => {
    const details = marketDetailsFromListings([
      { active: true, section: "107", row: "P", quantity: 2, price: 180 },
      { active: true, section: "108", row: "K", quantity: 4, price: 165 },
      { active: true, section: "119", row: "T", quantity: 2, price: 210 },
      { active: true, section: "216", row: "P", quantity: 2, price: 40 },
      { active: true, section: "107", row: "A", quantity: 2, price: 90 },
      { active: true, section: "107", row: "P", quantity: 1, price: 10 },
      { active: false, section: "107", row: "P", quantity: 2, price: 20 },
    ], "2026-09-15 11:00am");

    expect(details).toMatchObject({
      source: "seatdata",
      asof: "2026-09-15 11:00am",
      get_in: 40,
      median: 165,
      lower_level_get_in: 90,
      lower_level_median: 172.5,
      zone_get_in: 165,
      zone_median: 180,
      zone_comp_count: 3,
    });
    expect(details.zone_comps).toEqual([
      { section: "108", row: "K", quantity: 4, price: 165 },
      { section: "107", row: "P", quantity: 2, price: 180 },
      { section: "119", row: "T", quantity: 2, price: 210 },
    ]);
  });

  it("never fetches when the credential is an obvious placeholder", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSeatData(
      { env: env({ SEATDATA_API_KEY: "change-me-local-only" }), games: games(1), now },
      emptySpendState("2026-09-15"),
      "2026-09-15",
    );

    expect(result.result.aborted).toBe("missing_credential");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpendMock).not.toHaveBeenCalled();
  });

  it("reserves before fetch and caps listings at 20 per run", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(`fetch:${String(input)}`);
      if (String(input).includes("/v1/events/search")) {
        return new Response(JSON.stringify(searchBody(30)), { status: 200 });
      }
      return new Response(JSON.stringify({ listings: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockImplementation(async () => {
      calls.push("writeSpend");
    });

    const result = await runSeatData(
      { env: env(), games: games(30), now },
      emptySpendState("2026-09-15"),
      "2026-09-15",
    );

    expect(result.result.pulls).toBe(20);
    expect(result.spend.sources.seatdata.pullsToday).toBe(20);
    expect(fetchMock).toHaveBeenCalledTimes(21); // search + 20 listings
    expect(calls[0]).toBe("writeSpend");
    expect(calls[1]).toContain("/v1/events/search");
    expect(calls.filter((call) => call === "writeSpend")).toHaveLength(21);
  });

  it("prioritizes missing details, then the oldest snapshot, then game date", async () => {
    const selected: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/events/search")) {
        return new Response(JSON.stringify(searchBody(3)), { status: 200 });
      }
      selected.push(new URL(url).searchParams.get("event_id") ?? "");
      return new Response(JSON.stringify({ listings: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockResolvedValue(undefined);

    const baseline = games(3).map((game, index) => ({
      ...game,
      market_details: index === 1
        ? null
        : details(index === 0 ? "2026-09-15 11:00am" : "2026-09-14 11:00pm"),
    }));
    await runSeatData(
      { env: env(), games: baseline, now },
      emptySpendState("2026-09-15"),
      "2026-09-15",
    );

    expect(selected).toEqual(["2", "3", "1"]);
  });

  it("rotates an equal-age baseline after the first capped run", async () => {
    const selected: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/events/search")) {
        return new Response(JSON.stringify(searchBody(25)), { status: 200 });
      }
      selected.push(new URL(url).searchParams.get("event_id") ?? "");
      return new Response(JSON.stringify({ listings: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockResolvedValue(undefined);
    const baseline = games(25).map((game) => ({
      ...game,
      market_details: details("2026-09-15 11:00am"),
    }));
    const spend = emptySpendState("2026-09-15");
    const first = await runSeatData(
      { env: env(), games: baseline, now },
      spend,
      "2026-09-15",
    );
    expect(selected).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));

    selected.length = 0;
    first.spend.sources.seatdata.pullsToday = 0;
    first.spend.sources.seatdata.lastPullEtDate = null;
    await runSeatData(
      { env: env(), games: baseline, now },
      first.spend,
      "2026-09-15",
    );

    expect(selected).toEqual([
      ...Array.from({ length: 5 }, (_, index) => String(index + 21)),
      ...Array.from({ length: 15 }, (_, index) => String(index + 1)),
    ]);
  });

  it("stops at the 25-pull ET-day cap even when the run cap has room", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/v1/events/search")) {
        return new Response(JSON.stringify(searchBody(30)), { status: 200 });
      }
      return new Response(JSON.stringify({ listings: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockResolvedValue(undefined);

    const spend = emptySpendState("2026-09-15");
    spend.sources.seatdata.pullsToday = 24;
    spend.sources.seatdata.lastPullEtDate = "2026-09-15";
    const result = await runSeatData(
      { env: env(), games: games(30), now },
      spend,
      "2026-09-15",
    );

    expect(result.result.pulls).toBe(1);
    expect(result.spend.sources.seatdata.pullsToday).toBe(25);
    expect(fetchMock).toHaveBeenCalledTimes(2); // search + 1 listing
    expect(writeSpendMock).toHaveBeenCalledTimes(2); // source + listing reservation
  });

  it("does not search when the ET-day pull cap is already exhausted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const spend = emptySpendState("2026-09-15");
    spend.sources.seatdata.pullsToday = 25;
    spend.sources.seatdata.lastPullEtDate = "2026-09-15";

    const result = await runSeatData(
      { env: env(), games: games(1), now },
      spend,
      "2026-09-15",
    );

    expect(result.result).toMatchObject({ paid: false, aborted: "day_pull_cap", pulls: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpendMock).not.toHaveBeenCalled();
  });

  it("never fetches when the Apify credential is an obvious placeholder", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runApify(
      {
        env: env({ SOURCES: "apify", APIFY_TOKEN: "placeholder" }),
        games: games(1),
        now,
      },
      emptySpendState("2026-09-15"),
      "2026-09-15",
    );

    expect(result.result.aborted).toBe("missing_credential");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpendMock).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403])("opens SeatData circuit on provider rejection %s and stops after search", async (status) => {
    const fetchMock = vi.fn(async () => new Response("rejected", { status }));
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockResolvedValue(undefined);

    const spend = emptySpendState("2026-09-15");
    const result = await runSeatData(
      { env: env(), games: games(30), now },
      spend,
      "2026-09-15",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ paid: false, aborted: `http_${status}` });
    expect(result.spend.sources.seatdata.circuitOpenEtDate).toBe("2026-09-15");
  });

  it("opens Apify circuit on auth rejection without polling or retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("rejected", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    writeSpendMock.mockResolvedValue(undefined);

    const result = await runApify(
      { env: env({ SOURCES: "apify", APIFY_TOKEN: "real-apify-token" }), games: games(1), now },
      emptySpendState("2026-09-15"),
      "2026-09-15",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ paid: false, aborted: "http_403" });
    expect(result.spend.sources.apify.circuitOpenEtDate).toBe("2026-09-15");
  });
});
