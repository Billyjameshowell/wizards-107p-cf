import { describe, expect, it } from "vitest";
import { LIST_FLOOR } from "@shared/pricing";
import {
  buyerAllIn,
  fitQuoteFactors,
  quoteGame,
  tipBucket,
  type MarketQuote,
  type QuoteListing,
} from "@shared/quote";
import type { MarketRow } from "@shared/price-model";
import { applyTicketmasterIds, ticketmasterEventUrl } from "@shared/ticketmaster";
import seed from "../data/seed-book.json";

const ALL_IN = 1.23;

function pair(section: string, row: string, price: number): QuoteListing {
  return { section, row, quantity: 2, price, active: 1 };
}

function seller(allIn: number): number {
  return Math.round((allIn / ALL_IN) * 100) / 100;
}

function quote(partial: Parameters<typeof quoteGame>[0]): MarketQuote {
  return quoteGame({
    opponent: "Memphis Grizzlies",
    weekday: "Mon",
    date: "2026-11-16",
    timeEt: "7:00 PM",
    type: "regular",
    daysOut: 0,
    ...partial,
  });
}

describe("section quote", () => {
  it("prices a flooded section 107 at the cheaper rows, under the $75 floor", () => {
    // Grizzlies Mon 11/16, Ticketmaster all-in at 5:58pm, converted to seller dollars.
    const allIn = [39.36, 47.97, 47.97, 49.2, 51.66, 52.89, 61.5, 67.65, 68.88, 75.25, 75.25];
    const rows = ["Q", "R", "L", "K", "M", "J", "N", "O", "P", "S", "T"];
    const listings = allIn.map((price, index) => pair("107", rows[index] ?? "P", seller(price)));
    const priced = quote({ listings, listedAsk: 75, daysOut: 0, compDaysOut: 0 });
    expect(priced.pool).toBe("107");
    expect(priced.sectionCount).toBe(11);
    expect(priced.seller).toBeGreaterThan(35);
    expect(priced.seller).toBeLessThan(48);
    expect(priced.seller).toBeLessThan(LIST_FLOOR);
    expect(priced.seller).toBeLessThan(seller(68.88));
    expect(priced.allIn).toBe(buyerAllIn(priced.seller));
    expect(priced.low).toBeLessThanOrEqual(priced.seller);
    expect(priced.high).toBeGreaterThanOrEqual(priced.seller);
    expect(priced.cheapest107).toBe(32);
    expect(priced.delta).toBe(75 - 32);
    expect(priced.deltaOn).toBe("list");
    expect(priced.saleChance).toBeGreaterThan(0);
    expect(priced.saleChance).toBeLessThan(0.95);
  });

  it("prices the only pair in 107 up, and ignores a get-in", () => {
    const alone = quote({
      opponent: "Houston Rockets",
      weekday: "Sun",
      date: "2026-11-15",
      listings: [pair("107", "P", 70)],
      daysOut: 0,
    });
    const prior = quote({
      opponent: "Houston Rockets",
      weekday: "Sun",
      date: "2026-11-15",
      listings: [],
      daysOut: 0,
    });
    expect(alone.seller).toBeGreaterThan(70);
    expect(alone.seller).toBeGreaterThanOrEqual(Math.round(prior.seller * 0.9) - 1);
    expect(alone.pool).toBe("107");
    // Neighbors pull a thin 107 up off a cheap single.
    const fromNeighbors = quote({
      listings: [pair("107", "P", 50), pair("118", "N", 100), pair("119", "J", 140)],
      daysOut: 13,
      compDaysOut: 13,
      opponent: "Milwaukee Bucks",
      weekday: "Wed",
      date: "2026-10-21",
    });
    expect(fromNeighbors.pool).toBe("neighbors");
    expect(fromNeighbors.seller).toBeGreaterThan(120);
    expect(fromNeighbors.seller).toBeLessThan(160);
  });

  it("does not bake the floor into a soft game-day board", () => {
    const listings = [28, 30, 32, 34, 36, 40, 48, 55, 60, 70].map((price, index) =>
      pair("107", "JKLMNOPQRST"[index] ?? "P", price),
    );
    const priced = quote({
      opponent: "Detroit Pistons",
      weekday: "Thu",
      date: "2026-11-12",
      listings,
      daysOut: 0,
    });
    expect(priced.seller).toBeGreaterThanOrEqual(30);
    expect(priced.seller).toBeLessThanOrEqual(38);
    expect(priced.seller).not.toBe(LIST_FLOOR);
  });

  it("reads tip time and keeps preseason under a regular-season Friday", () => {
    expect(tipBucket("1:00 PM")).toBe("early");
    expect(tipBucket("7:00 PM")).toBe("prime");
    expect(tipBucket("8:00 PM")).toBe("late");
    const pre = quote({
      listings: [],
      opponent: "Detroit Pistons",
      weekday: "Sat",
      date: "2026-10-10",
      type: "preseason",
      daysOut: 2,
    });
    const regular = quote({
      listings: [],
      opponent: "Toronto Raptors",
      weekday: "Fri",
      date: "2026-10-23",
      daysOut: 14,
    });
    expect(pre.seller).toBeLessThan(40);
    expect(regular.seller).toBeGreaterThan(pre.seller);
    expect(pre.pool).toBe("prior");
  });

  it("moves the marquee factor off the prior when the archive is thick", () => {
    const clean: MarketRow[] = [];
    let n = 0;
    for (const tier of ["marquee", "standard", "soft"] as const) {
      for (let game = 0; game < 4; game += 1) {
        for (let day = 0; day < 4; day += 1) {
          const level = tier === "marquee" ? 140 : tier === "soft" ? 60 : 90;
          const gameDate = new Date(Date.parse("2026-12-01T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
          n += 1;
          clean.push({
            gameDate,
            snapshotDate: `2026-11-${String(10 + day).padStart(2, "0")}`,
            daysOut: 8 + day,
            median: level,
            tier,
            weekend: game % 2 === 0,
            nationalTv: false,
            winRate: 0.4,
            supply: 6,
            weekday: "Fri",
            tip: "prime",
          });
        }
      }
    }
    const fit = fitQuoteFactors(clean, "2026-11-01");
    expect(fit.source).toBe("archive");
    expect(fit.tier.marquee).toBeGreaterThan(1.15);
    expect(fit.tier.soft).toBeLessThan(0.9);
    expect(fit.tier.marquee).toBeGreaterThan(fit.tier.soft);
  });
});

describe("known misses", () => {
  type Case = {
    name: string;
    oldAsk: number;
    actual: number;
    note: string;
    quote: MarketQuote;
  };

  const grizzliesAllIn = [39.36, 47.97, 47.97, 49.2, 51.66, 52.89, 61.5, 67.65, 68.88, 75.25, 75.25];
  const grizzlies = quote({
    listings: grizzliesAllIn.map((price, index) => pair("107", "JKLMNOPQRST"[index] ?? "P", seller(price))),
    listedAsk: 75,
  });
  const rockets = quote({
    opponent: "Houston Rockets",
    weekday: "Sun",
    date: "2026-11-15",
    listings: [pair("107", "P", 70)],
    daysOut: 0,
  });
  const pistonsBoard = quote({
    opponent: "Detroit Pistons",
    weekday: "Thu",
    date: "2026-11-12",
    listings: [28, 30, 32, 34, 36, 40, 48, 55, 60, 70].map((price, index) => pair("107", "JKLMNOPQRST"[index] ?? "P", price)),
    daysOut: 0,
  });
  const hornets = quote({
    opponent: "Charlotte Hornets",
    weekday: "Fri",
    date: "2026-10-30",
    listings: [60, 70, 75, 85, 100].map((price, index) => pair("107", "JKLMN"[index] ?? "P", price)),
    daysOut: 0,
  });
  const raptors = quote({
    opponent: "Toronto Raptors",
    weekday: "Fri",
    date: "2026-10-23",
    listings: [70, 80, 88, 95, 110, 130].map((price, index) => pair("107", "JKLMNO"[index] ?? "P", price)),
    daysOut: 1,
  });
  const nets = quote({
    opponent: "Brooklyn Nets",
    weekday: "Mon",
    date: "2026-10-12",
    type: "preseason",
    listings: [35, 40, 44, 48, 55, 60].map((price, index) => pair("107", "JKLMNO"[index] ?? "P", price)),
    daysOut: 0,
  });
  const pistonsPre = quote({
    opponent: "Detroit Pistons",
    weekday: "Sat",
    date: "2026-10-10",
    type: "preseason",
    listings: [22, 26, 30, 34, 40].map((price, index) => pair("107", "JKLMN"[index] ?? "P", price)),
    daysOut: 0,
  });

  const cases: Case[] = [
    { name: "Grizzlies Mon 11/16", oldAsk: 73, actual: 32, note: "unsold at $75; cheapest seller $32; row P $56", quote: grizzlies },
    { name: "Rockets Sun 11/15", oldAsk: 50, actual: 83, note: "instant $50; TM relist $101.64 all-in ($83 seller); only pair listed at $70", quote: rockets },
    { name: "Pistons Thu 11/12", oldAsk: 76, actual: 32, note: "instant $32; flooded board reconstructed around that sale", quote: pistonsBoard },
    { name: "Hornets Fri 10/30", oldAsk: 84, actual: 75, note: "sold $75; old model was quoted $84–$150", quote: hornets },
    { name: "Raptors Fri 10/23", oldAsk: 155, actual: 70, note: "listed $100, unsold; cheapest of a reconstructed board", quote: raptors },
    { name: "Nets preseason", oldAsk: 78, actual: 35, note: "listed $51, unsold; cheapest of a reconstructed board", quote: nets },
    { name: "Pistons preseason", oldAsk: 55, actual: 30, note: "sold $30", quote: pistonsPre },
  ];

  it("beats the old ask against the market on every recorded miss", () => {
    const scored = cases.map((row) => {
      const newError = Math.abs(row.quote.seller - row.actual) / row.actual;
      const oldError = Math.abs(row.oldAsk - row.actual) / row.actual;
      return { ...row, newAsk: row.quote.seller, newError, oldError };
    });
    for (const row of scored) {
      expect(row.newError, row.name).toBeLessThan(row.oldError);
      expect(row.newAsk, row.name).not.toBe(LIST_FLOOR);
    }
    const median = (values: number[]) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 1;
    };
    const newMedian = median(scored.map((row) => row.newError));
    const oldMedian = median(scored.map((row) => row.oldError));
    expect(newMedian).toBeLessThan(oldMedian);
    expect(newMedian).toBeLessThan(0.2);
    // Locked for the PR table. Seller dollars.
    expect(scored.map((row) => [row.name, row.oldAsk, row.newAsk, row.actual])).toEqual([
      ["Grizzlies Mon 11/16", 73, 40, 32],
      ["Rockets Sun 11/15", 50, 86, 83],
      ["Pistons Thu 11/12", 76, 33, 32],
      ["Hornets Fri 10/30", 84, 73, 75],
      ["Raptors Fri 10/23", 155, 88, 70],
      ["Nets preseason", 78, 44, 35],
      ["Pistons preseason", 55, 28, 30],
    ]);
  });
});

describe("ticketmaster ids", () => {
  it("builds the canonical event url and fills a live book from the seed", () => {
    const book = seed as { games: { date: string; tm_event_id?: string }[] };
    expect(book.games).toHaveLength(43);
    expect(new Set(book.games.map((game) => game.date)).size).toBe(43);
    for (const game of book.games) {
      expect(game.tm_event_id, game.date).toMatch(/^[0-9A-F]+$/);
      expect(ticketmasterEventUrl(game.tm_event_id)).toBe(`https://www.ticketmaster.com/event/${game.tm_event_id}`);
    }
    expect(book.games.find((game) => game.date === "2026-11-16")?.tm_event_id).toBe("15006505D811A19F");
    expect(book.games.find((game) => game.date === "2026-12-04")?.tm_event_id).toBe("15006505D826A1C7");
    const live = applyTicketmasterIds(
      [{ date: "2026-11-16", tm_event_id: null }, { date: "2026-11-15", tm_event_id: "KEEP" }],
      book.games,
    );
    expect(live[0]?.tm_event_id).toBe("15006505D811A19F");
    expect(live[1]?.tm_event_id).toBe("KEEP");
  });
});
