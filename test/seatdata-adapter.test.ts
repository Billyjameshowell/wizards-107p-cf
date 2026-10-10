import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySpendState, type SpendState } from "@shared/guardrails";
import type { Game } from "@shared/book";
import { runSeatData, slimListingsPayload } from "../worker/adapters/seatdata";

function env(overrides: Record<string, string> = {}): Env {
  return {
    INGEST_ENABLED: "true",
    DRY_RUN: "false",
    SOURCES: "seatdata",
    SEATDATA_API_KEY: "test-key",
    SEATDATA_BASE_URL: "https://seatdata.io",
    ...overrides,
  } as unknown as Env;
}

const games = [
  { date: "2026-10-21", opponent: "Bucks", sit_or_sell: "Sell" },
  { date: "2026-10-23", opponent: "Raptors", sit_or_sell: "Sell" },
  { date: "2026-10-25", opponent: "Celtics", sit_or_sell: "Sell" },
] as unknown as Game[];

/** A SeatData-sized payload: thousands of listings, only a few in the comp zone. */
function bigListings(count: number): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ section: "4" + (i % 30), row: "A", quantity: 2, price: 20 + (i % 50), active: 1 });
  }
  rows.push({ section: "107", row: "R", quantity: 2, price: 60, active: 1 });
  rows.push({ section: "118", row: "N", quantity: 4, price: 70, active: true });
  rows.push({ section: "108", row: "M", quantity: 2, price: 80, active: 1 });
  return rows;
}

function mockSeatData(hasRefreshed: number) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/events/search")) {
        return Response.json({
          data: games.map((game, index) => ({
            event_id: 100 + index,
            event_date: game.date,
            event_name: `${game.opponent} at Washington Wizards`,
            venue_name: "Capital One Arena",
          })),
        });
      }
      if (url.includes("/listings/get")) {
        return Response.json({ has_refreshed: hasRefreshed, listings: bigListings(5000) });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

describe("slimListingsPayload", () => {
  it("keeps only comp-zone listings plus a small raw summary", () => {
    const slim = slimListingsPayload({ has_refreshed: 1, listings: bigListings(5000) as never });
    expect(slim.total).toBe(5003);
    expect(slim.comps.map((listing) => listing.price)).toEqual([60, 70, 80]);
    expect(slim.raw).toEqual({ has_refreshed: 1, listing_total: 5003, comp_listings: 3 });
  });
});

describe("runSeatData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("archives comp listings only and checkpoints spend after each paid pull", async () => {
    mockSeatData(1);
    const saved: SpendState[] = [];
    const out = await runSeatData(
      {
        env: env(),
        games,
        now: new Date("2026-10-08T21:00:00Z"),
        saveSpend: async (spend) => {
          saved.push(structuredClone(spend));
        },
      },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(out.result.pulls).toBe(3);
    expect(out.result.points.map((point) => point.compMedian)).toEqual([70, 70, 70]);
    const gameRows = out.observations.filter((row) => row.gameDate);
    expect(gameRows).toHaveLength(3);
    for (const row of gameRows) {
      expect(row.listingCount).toBe(5003);
      expect((row.listings as unknown[]).length).toBe(3);
      expect(row.raw).toEqual({ has_refreshed: 1, listing_total: 5003, comp_listings: 3 });
    }
    // One checkpoint for the paid attempt, then one per paid pull.
    expect(saved.map((spend) => spend.sources.seatdata.pullsToday)).toEqual([0, 1, 2, 3]);
  });

  it("caps listing calls per run even when SeatData serves cached (unpaid) data", async () => {
    const calls = mockSeatData(0);
    const out = await runSeatData(
      { env: env({ SEATDATA_MAX_PULLS_PER_RUN: "2" }), games, now: new Date("2026-10-08T21:00:00Z") },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(calls.filter((url) => url.includes("/listings/get"))).toHaveLength(2);
    expect(out.result.pulls).toBe(0);
    expect(out.observations.some((row) => row.error === "run_fetch_cap")).toBe(true);
  });
});
