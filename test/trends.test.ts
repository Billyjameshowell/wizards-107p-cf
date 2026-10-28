import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planLegacyArchive } from "@shared/archive";
import { NOT_ENOUGH_DATA } from "@shared/price-model";
import {
  bandQuote,
  buildTrendsReport,
  cleanedMarketRows,
  plausibleCheapest,
  type TrendListing,
  type TrendPull,
  type TrendsGameSeed,
  type TrendsReport,
} from "@shared/trends";

const legacy = JSON.parse(
  readFileSync(new URL("../data/legacy-price-history.json", import.meta.url), "utf8"),
) as unknown[];

function seed(partial: Partial<TrendsGameSeed> & Pick<TrendsGameSeed, "date" | "opponent">): TrendsGameSeed {
  return {
    weekday: "Wed",
    timeEt: "7:00 PM",
    type: "regular",
    demand: null,
    bookMedian: null,
    ...partial,
  };
}

function pull(partial: Partial<TrendPull> & Pick<TrendPull, "id" | "source" | "gameDate">): TrendPull {
  return {
    pulledAt: "2026-09-01T16:00:00.000Z",
    etDate: "2026-09-01",
    opponent: "Milwaukee Bucks",
    median: null,
    getIn: null,
    liveAsk: null,
    legacyLabel: null,
    payload: null,
    ...partial,
  };
}

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  for (const [key, item] of Object.entries(value)) {
    into.add(key);
    keysOf(item, into);
  }
  return into;
}

describe("similar-seat quotes", () => {
  it("uses the middle and cheapest of 107/108/118/119 rows J–T, and leaves out one lone 107P dump", () => {
    const quote = bandQuote([
      { active: 1, section: "107", row: "P", quantity: 2, price: 50 },
      { active: 1, section: "118", row: "N", quantity: 2, price: 100 },
      { active: 1, section: "119", row: "J", quantity: 2, price: 140 },
      { active: 1, section: "200", row: "A", quantity: 2, price: 10 },
      { active: 1, section: "107", row: "A", quantity: 2, price: 20 },
      { active: 1, section: "108", row: "K", quantity: 1, price: 15 },
    ]);
    expect(quote).toEqual({ median: 120, cheapest: 100, count: 2 });
  });

  it("drops an arena floor that is nowhere near the similar-seat middle", () => {
    expect(plausibleCheapest(8, 230)).toBeNull();
    expect(plausibleCheapest(89, 236)).toBe(89);
  });
});

describe("projection anchored to today's comps", () => {
  // Five listed games checked daily for a week, one game nobody lists, one TBD slot.
  const dates = ["2026-12-02", "2026-12-09", "2026-12-16", "2027-01-06", "2027-01-13"];
  const opponents = ["Philadelphia 76ers", "Detroit Pistons", "Chicago Bulls", "Toronto Raptors", "Orlando Magic"];
  const level = [700, 130, 90, 120, 110];
  const pulls: TrendPull[] = [];
  const listings: TrendListing[] = [];
  let id = 1;
  for (const [game, date] of dates.entries()) {
    for (let day = 0; day < 7; day += 1) {
      const etDate = `2026-10-${String(20 + day).padStart(2, "0")}`;
      const middle = level[game]! * (1 + 0.004 * day);
      pulls.push(pull({ id, source: "seatdata", gameDate: date, opponent: opponents[game]!, etDate, pulledAt: `${etDate}T12:00:00.000Z`, compCount: 3 }));
      for (const [index, price] of [middle * 0.9, middle, middle * 1.1].entries()) {
        listings.push({ pullId: id, section: "118", row: ["K", "M", "P"][index]!, quantity: 2, price: Math.round(price * 100) / 100, active: 1 });
      }
      id += 1;
    }
  }
  // An early pull that saved only one of its 40 comps, far under the game's real middle.
  pulls.push(pull({ id, source: "seatdata", gameDate: dates[0]!, opponent: opponents[0]!, etDate: "2026-10-12", pulledAt: "2026-10-12T12:00:00.000Z", compCount: 40 }));
  listings.push({ pullId: id, section: "118", row: "K", quantity: 2, price: 250, active: 1 });
  const games = [
    ...dates.map((date, index) => seed({ date, opponent: opponents[index]! })),
    seed({ date: "2027-01-20", opponent: "Chicago Bulls" }),
    seed({ date: "2026-12-30", opponent: "TBD (NBA Cup week)" }),
  ];
  const report = buildTrendsReport({ today: "2026-10-28", games, pulls, listings });
  const byDate = new Map(report.games.map((game) => [game.date, game]));

  it("prices a listed game off its latest middle, not a level fitted on other games", () => {
    const sixers = byDate.get("2026-12-02")!;
    expect(sixers.projection.enough).toBe(true);
    expect(sixers.projection.todayPrice).toBe(Math.round(sixers.latestMedian!));
    expect(sixers.ask!).toBeGreaterThan(sixers.latestMedian! * 0.85);
  });

  it("keeps a partial listings pull out of the fit and shows it only as a weak reading", () => {
    const sixers = byDate.get("2026-12-02")!;
    expect(sixers.series[0]).toMatchObject({ date: "2026-10-12", median: 250 });
    // A 250 → 700 jump would read as prices nearly tripling toward tip if the fit saw it.
    const rows = cleanedMarketRows({ today: "2026-10-28", games, pulls, listings });
    expect(rows.filter((row) => row.gameDate === "2026-12-02")).toHaveLength(7);
    expect(rows.some((row) => row.median < 600 && row.gameDate === "2026-12-02")).toBe(false);
  });

  it("gives an unlisted game a price from similar games, and leaves a TBD slot alone", () => {
    const unlisted = byDate.get("2027-01-20")!;
    expect(unlisted.checks).toBe(0);
    expect(unlisted.projection.sentence).toMatch(/No similar seats are listed for this game yet/);
    expect(unlisted.ask).not.toBeNull();
    const tbd = byDate.get("2026-12-30")!;
    expect(tbd.projection.enough).toBe(false);
    expect(tbd.ask).toBeNull();
  });
});

describe("buildTrendsReport", () => {
  const game = seed({ date: "2026-10-21", opponent: "Milwaukee Bucks" });

  it("prefers parsed similar seats over a stored middle, and ignores the rest of the arena", () => {
    const report = buildTrendsReport({
      today: "2026-10-08",
      games: [game],
      pulls: [pull({ id: 1, source: "seatdata", gameDate: "2026-10-21", median: 999, getIn: 1 })],
      listings: [
        { pullId: 1, section: "107", row: "P", quantity: 2, price: 50, active: 1 },
        { pullId: 1, section: "118", row: "N", quantity: 2, price: 100, active: 1 },
        { pullId: 1, section: "119", row: "J", quantity: 2, price: 140, active: 1 },
        { pullId: 1, section: "400", row: "1", quantity: 2, price: 9, active: 1 },
      ] satisfies TrendListing[],
    });
    expect(report.games[0]?.series).toEqual([
      { date: "2026-09-01", daysOut: 50, median: 120, cheapest: 100 },
    ]);
    // The ask is the price model's, priced off that 120 middle, with its sale chance.
    const ask = report.games[0]?.ask ?? 0;
    expect(ask).toBeGreaterThanOrEqual(84);
    expect(ask).toBeLessThanOrEqual(180);
    expect(report.games[0]?.ask).toBe(report.outlook.asks["2026-10-21"]?.ask);
    expect(report.games[0]?.askChance).toBeGreaterThan(0);
    expect(report.games[0]?.askChance).toBeLessThan(0.95);
    expect(report.games[0]?.keep).toBe(Math.round(ask * 0.95 * 100) / 100);
    expect(report.games[0]?.pair).toBe(Math.round(ask * 1.9 * 100) / 100);
  });

  it("does not treat arena-wide prices as similar seats", () => {
    const report = buildTrendsReport({
      today: "2026-10-08",
      games: [game],
      pulls: [pull({ id: 7, source: "apify", gameDate: "2026-10-21", median: 40, getIn: 12 })],
      listings: [],
    });
    expect(report.games[0]?.checks).toBe(0);
    expect(report.games[0]?.series).toEqual([]);
    expect(report.games[0]?.projection.sentence).toBe(NOT_ENOUGH_DATA);
    expect(report.games[0]?.ask).toBeNull();
  });

  it("computes a 7-day change and a since-first change from daily middles", () => {
    const report = buildTrendsReport({
      today: "2026-09-21",
      games: [game],
      pulls: [
        pull({ id: 1, source: "seatdata", gameDate: "2026-10-21", etDate: "2026-09-01", pulledAt: "2026-09-01T16:00:00.000Z", median: 200 }),
        pull({ id: 2, source: "seatdata", gameDate: "2026-10-21", etDate: "2026-09-08", pulledAt: "2026-09-08T16:00:00.000Z", median: 180 }),
        pull({ id: 3, source: "seatdata", gameDate: "2026-10-21", etDate: "2026-09-20", pulledAt: "2026-09-20T16:00:00.000Z", median: 190 }),
      ],
      listings: [],
    });
    const row = report.games[0];
    expect(row?.change7d).toBe(5.6);
    expect(row?.changeSinceFirst).toBe(-5);
    expect(row?.checks).toBe(3);
    expect(row?.projection.enough).toBe(false);
    expect(row?.projection.sentence).toBe(NOT_ENOUGH_DATA);
  });

  it("reads the legacy backfill into a public report with no raw fields", () => {
    const planned = planLegacyArchive(legacy);
    const pulls: TrendPull[] = planned.pulls.map((row, index) => ({
      id: index + 1,
      pulledAt: row.pulledAt,
      etDate: row.etDate,
      source: row.source,
      gameDate: row.gameDate,
      opponent: row.opponent,
      median: row.median,
      getIn: row.getIn,
      liveAsk: row.liveAsk,
      legacyLabel: row.legacyLabel,
      payload: row.payload,
    }));
    const report = buildTrendsReport({
      today: "2026-10-08",
      games: [
        seed({ date: "2026-10-10", opponent: "Detroit Pistons", weekday: "Sat", type: "preseason" }),
        seed({ date: "2026-10-21", opponent: "Milwaukee Bucks", weekday: "Wed" }),
      ],
      pulls,
      listings: [],
    });
    expect(report.gamesWithChecks).toBeGreaterThanOrEqual(14);
    expect(report.firstCheck).toBeTruthy();
    expect(report.lastCheck).toBeTruthy();
    expect(report.daysOutCurve.length).toBeGreaterThan(0);
    expect(report.daysOutCurve.every((bucket) => bucket.count >= 3 && bucket.index > 0)).toBe(true);

    const bucks = report.games.find((row) => row.date === "2026-10-21");
    expect(bucks?.checks).toBe(7);
    expect(bucks?.series[0]?.median).toBe(247.88);
    expect(bucks?.series[bucks.series.length - 1]?.median).toBe(236.79);
    expect(bucks?.series.some((point) => point.date > "2026-09-10" && point.median > 245)).toBe(false);
    expect(bucks?.latestCheapest).toBeGreaterThan(80);
    expect(bucks?.latestCheapest).toBeLessThan(120);
    expect(bucks?.changeSinceFirst).toBeLessThan(0);
    // The backfill has no full listing pulls, so the path-to-tip fit waits; the ask still
    // comes from the latest similar-seat middle.
    expect(bucks?.projection.enough).toBe(false);
    expect(bucks?.offers.length).toBeGreaterThan(0);
    expect(bucks?.ask).not.toBeNull();
    expect(bucks?.instantOffer).toBeNull();
    expect(bucks?.takeInstant).toBe(false);

    const pistons = report.games.find((row) => row.date === "2026-10-10");
    expect(pistons?.checks).toBe(0);
    expect(pistons?.projection.enough).toBe(false);

    expectPublic(report);
  });
});

function expectPublic(report: TrendsReport) {
  const names = [...keysOf(report)];
  expect(names.some((name) => /payload|secret|raw|get_in|source|listing|cron|apify|seatdata/i.test(name))).toBe(
    false,
  );
  const text = JSON.stringify(report);
  expect(text).not.toContain("payload_json");
  expect(text).not.toContain("legacy_label");
  expect(text).not.toContain("external_id");
  expect(text).not.toContain("seatdata");
  expect(text).not.toContain("apify");
}

describe("instant offer floor", () => {
  it("shows the logged payout and tells you to take it when a listing would clear less near tip", () => {
    const report = buildTrendsReport({
      today: "2026-10-08",
      games: [seed({ date: "2026-10-10", opponent: "Detroit Pistons", weekday: "Sat" })],
      pulls: [
        pull({ id: 1, source: "seatdata", gameDate: "2026-10-10", etDate: "2026-10-01", pulledAt: "2026-10-01T16:00:00.000Z", median: 8 }),
        pull({ id: 2, source: "seatdata", gameDate: "2026-10-10", etDate: "2026-10-08", pulledAt: "2026-10-08T16:00:00.000Z", median: 9 }),
      ],
      listings: [],
      instantOffers: [
        {
          gameDate: "2026-10-10",
          total: 26.6,
          perTicket: 13.3,
          observedAt: "2026-10-08T15:00:00.000Z",
          note: null,
        },
      ],
    });
    const game = report.games.find((row) => row.date === "2026-10-10");
    expect(game?.instantOffer).toMatchObject({ total: 26.6, perTicket: 13.3, seen: "2026-10-08" });
    expect(game?.instantOffer?.seenAt).toMatch(/^2026-10-08/);
    expect(game?.takeInstant).toBe(true);
    expect(game?.projection.suggestion?.sentence).toMatch(/Take the instant offer/);
    expect(game?.projection.suggestion?.sentence).toMatch(/\$26\.60/);
    expect(game?.projection.suggestion?.sentence).not.toMatch(/Nothing is listed/);
    expectPublic(report);
    expect(JSON.stringify(report)).not.toContain("tm_instant_offer");
  });
});

describe("trends route", () => {
  it("serves /api/trends without the export secret, and leaves /api/export locked", () => {
    const index = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    const trendsAt = index.indexOf('"/api/trends"');
    const exportAt = index.indexOf('"/api/export"');
    expect(trendsAt).toBeGreaterThan(0);
    expect(exportAt).toBeGreaterThan(trendsAt);
    expect(index.slice(trendsAt, exportAt)).not.toContain("authorizeBearer");
    expect(index.slice(trendsAt, exportAt)).toContain("trendsResponse");
    expect(index.slice(exportAt, exportAt + 400)).toContain("authorizeBearer");
    const offersAt = index.indexOf('"/api/instant-offers"');
    expect(offersAt).toBeGreaterThan(exportAt);
    expect(index.slice(offersAt, offersAt + 200)).toContain("instantOfferApiResponse");

    const handler = readFileSync(new URL("../worker/trends.ts", import.meta.url), "utf8");
    expect(handler).toContain("buildTrendsReport");
    expect(handler).not.toContain("CRON_SECRET");
    expect(handler).not.toContain("authorizeBearer");
  });
});
