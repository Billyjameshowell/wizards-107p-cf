import { describe, expect, it } from "vitest";
import type { Game } from "@shared/book";
import { keepFromTypeIn, pairFromTypeIn } from "@shared/book";
import { parsePriceOverrides } from "@/lib/price-overrides";
import { demandOf, resolveSeatPrice, seatPriceForGame, seriousCompMedian } from "@shared/pricing";

function game(partial: Partial<Game> & Record<string, unknown> = {}): Game {
  return {
    date: "2026-10-12",
    weekday: "Mon",
    time_et: "7:00 PM",
    opponent: "Brooklyn Nets",
    type: "preseason",
    sit_or_sell: "Sell",
    advised_ask: null,
    cash_both_after_fee: null,
    listed: false,
    listed_ask: null,
    sold: false,
    notes: "Marquee wording in notes is not a tier",
    ticketdata_url: null,
    ...partial,
  } as Game;
}

describe("model ask", () => {
  it("suggests the price model's ask, with its sale chance, and shows the comp middle beside it", () => {
    const view = resolveSeatPrice({
      modelAsk: { ask: 171, chance: 0.72, expected: 233.9 },
      listedMedian: 176,
      compCount: 9,
      excludedDump: false,
      daysOut: 13,
      savedTypeIn: null,
    });
    expect(view.suggestion?.typeIn).toBe(171);
    expect(view.suggestion?.keep).toBe(keepFromTypeIn(171));
    expect(view.suggestion?.pair).toBe(pairFromTypeIn(171));
    expect(view.suggestion?.listedMedian).toBe(176);
    expect(view.suggestion?.saleChance).toBe(0.72);
    expect(view.suggestion?.label).toContain("72%");
    expect(view.typeIn).toBe(171);
  });

  it("has no suggestion when the model has no ask, even with comps", () => {
    const view = resolveSeatPrice({
      modelAsk: null,
      listedMedian: 176,
      compCount: 9,
      excludedDump: false,
      daysOut: 13,
      savedTypeIn: null,
    });
    expect(view.suggestion).toBeNull();
    expect(view.typeIn).toBeNull();
    expect(view.emptyNote).toContain("no ask");
  });
});

describe("serious comps", () => {
  it("uses the middle and leaves out one lone cheap Section 107 Row P listing", () => {
    const snapshot = seriousCompMedian([
      { active: true, section: "107", row: "P", quantity: 2, price: 50 },
      { active: true, section: "107", row: "P", quantity: 2, price: 180 },
      { active: true, section: "108", row: "K", quantity: 2, price: 165 },
      { active: true, section: "119", row: "T", quantity: 4, price: 210 },
      { active: true, section: "216", row: "P", quantity: 2, price: 40 },
      { active: true, section: "107", row: "A", quantity: 2, price: 90 },
      { active: false, section: "107", row: "P", quantity: 2, price: 20 },
      { active: true, section: "107", row: "P", quantity: 1, price: 30 },
    ]);
    expect(snapshot.excludedDump).toBe(true);
    expect(snapshot.count).toBe(3);
    expect(snapshot.median).toBe(180);
  });

  it("does not drop a cheap listing that is not a lone 107 Row P", () => {
    const snapshot = seriousCompMedian([
      { active: true, section: "108", row: "K", quantity: 2, price: 100 },
      { active: true, section: "107", row: "P", quantity: 2, price: 200 },
      { active: true, section: "119", row: "T", quantity: 2, price: 180 },
    ]);
    expect(snapshot.excludedDump).toBe(false);
    expect(snapshot.median).toBe(180);
  });
});

describe("saved price", () => {
  it("keeps any whole dollar he typed and does not round it to 0 or 5", () => {
    const view = resolveSeatPrice({
      modelAsk: { ask: 199, chance: 0.7, expected: 264.7 },
      listedMedian: 200,
      compCount: 6,
      excludedDump: true,
      daysOut: 10,
      savedTypeIn: 151,
    });
    expect(view.suggestion?.typeIn).toBe(199);
    expect(view.typeIn).toBe(151);
    expect(view.keep).toBe(keepFromTypeIn(151));
    expect(view.usingOwn).toBe(true);
  });

  it("does not replace his number when the days or the middle change", () => {
    const far = resolveSeatPrice({
      modelAsk: { ask: 180, chance: 0.7, expected: 239.4 },
      listedMedian: 180,
      compCount: 4,
      excludedDump: false,
      daysOut: 40,
      savedTypeIn: 49,
    });
    const close = resolveSeatPrice({
      modelAsk: { ask: 230, chance: 0.6, expected: 262.2 },
      listedMedian: 240,
      compCount: 8,
      excludedDump: false,
      daysOut: 3,
      savedTypeIn: 49,
    });
    expect(far.suggestion?.typeIn).not.toBe(49);
    expect(far.typeIn).toBe(49);
    expect(far.keep).toBe(46.55);
    expect(close.typeIn).toBe(49);
    expect(close.keep).toBe(46.55);
  });

  it("ignores arena median, the old lowest ask, and note wording", () => {
    const row = game({
      market_median: 400,
      advised_ask: 20,
      notes: "Marquee Rockets",
    });
    expect(demandOf(row)).toBeNull();
    const view = resolveSeatPrice({
      modelAsk: null,
      listedMedian: null,
      compCount: null,
      excludedDump: false,
      daysOut: 13,
      savedTypeIn: null,
    });
    expect(view.suggestion).toBeNull();
    expect(view.typeIn).toBeNull();
  });

  it("uses zone_median when the stored book has no comp_median, and the model ask for the price", () => {
    const stored = game({
      model_ask: 158,
      model_sale_chance: 0.7,
      date: "2026-10-23",
      weekday: "Fri",
      opponent: "Toronto Raptors",
      type: "regular",
      market_details: {
        zone_median: 161.11,
        zone_comp_count: 174,
        get_in: 48,
        median: 90,
      },
    });
    expect(stored.comp_median).toBeUndefined();
    const view = seatPriceForGame(stored, null, "2026-09-22");
    expect(view.suggestion?.listedMedian).toBe(161.11);
    expect(view.suggestion?.compCount).toBe(174);
    expect(view.typeIn).toBe(158);
    expect(view.pair).not.toBeNull();

    const withComp = game({
      date: "2026-10-23",
      model_ask: 190,
      comp_median: 200,
      comp_count: 8,
      market_details: stored.market_details,
    });
    const preferred = seatPriceForGame(withComp, null, "2026-09-22");
    expect(preferred.suggestion?.listedMedian).toBe(200);
    expect(preferred.suggestion?.compCount).toBe(8);
  });
});

describe("parsePriceOverrides", () => {
  it("stores whole dollars and drops junk", () => {
    expect(parsePriceOverrides({ "2026-10-12": 151.4, "2026-10-10": 49, bad: 10, "2026-10-21": 0 })).toEqual({
      "2026-10-12": 151,
      "2026-10-10": 49,
    });
  });
});
