import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planLegacyArchive } from "@shared/archive";
import { NOT_ENOUGH_DATA } from "@shared/price-model";
import {
  bandQuote,
  buildTrendsReport,
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
    expect(report.games[0]?.ask).toBe(120);
    expect(report.games[0]?.keep).toBe(114);
    expect(report.games[0]?.pair).toBe(228);
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
    expect(bucks?.projection.enough).toBe(true);
    expect(bucks?.projection.early).toBe(true);
    expect(bucks?.projection.sentence).toMatch(/Early estimate/);
    expect(bucks?.projection.sentence).toMatch(/by tip/);
    expect(bucks?.projection.price).not.toBeNull();
    expect(bucks?.projection.todayPrice).not.toBeNull();
    expect(bucks?.projection.suggestion?.sentence).toMatch(/Nothing is listed for you/);
    expect(bucks?.ask).not.toBeNull();

    const pistons = report.games.find((row) => row.date === "2026-10-10");
    expect(pistons?.checks).toBe(0);
    expect(pistons?.projection.sentence).toBe(NOT_ENOUGH_DATA);

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

    const handler = readFileSync(new URL("../worker/trends.ts", import.meta.url), "utf8");
    expect(handler).toContain("buildTrendsReport");
    expect(handler).not.toContain("CRON_SECRET");
    expect(handler).not.toContain("authorizeBearer");
  });
});
