import { describe, expect, it } from "vitest";
import type { Game } from "@shared/book";
import { keepFromTypeIn, pairFromTypeIn } from "@shared/book";
import { parsePriceOverrides } from "@/lib/price-overrides";
import {
  demandOf,
  resolveSeatPrice,
  roundSuggestedTypeIn,
  seatPriceForGame,
  seriousCompMedian,
  suggestFromMedian,
} from "@shared/pricing";

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

describe("roundSuggestedTypeIn", () => {
  it("rounds the suggested type-in to a whole dollar ending in 0 or 5", () => {
    expect(roundSuggestedTypeIn(150, 150)).toBe(150);
    expect(roundSuggestedTypeIn(175, 175)).toBe(175);
    expect(roundSuggestedTypeIn(172, 172)).toBe(170);
    expect(roundSuggestedTypeIn(173, 173)).toBe(175);
    expect(roundSuggestedTypeIn(178, 178)).toBe(180);
    expect(roundSuggestedTypeIn(177.5, 177.5)).toBe(180);
    expect(String(roundSuggestedTypeIn(176.2, 176.2))).not.toMatch(/\.|99$/);
  });

  it("uses a 9 only when that drops the first digit versus the unrounded middle", () => {
    expect(roundSuggestedTypeIn(200, 200)).toBe(199);
    expect(roundSuggestedTypeIn(202, 202)).toBe(199);
    expect(roundSuggestedTypeIn(100, 100)).toBe(99);
    expect(roundSuggestedTypeIn(1000, 1000)).toBe(999);
    expect(roundSuggestedTypeIn(500, 500)).toBe(499);
    expect(roundSuggestedTypeIn(150, 150)).toBe(150);
    expect(roundSuggestedTypeIn(148, 148)).toBe(150);
    expect(roundSuggestedTypeIn(198, 198)).toBe(200);
    expect(roundSuggestedTypeIn(250, 250)).toBe(250);
    expect(roundSuggestedTypeIn(190, 200)).toBe(190);
  });
});

describe("suggestFromMedian", () => {
  it("stays on the middle for an unmarked game, including the active window", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 176,
      daysOut: 13,
      demand: null,
    });
    expect(suggestion.typeIn).toBe(175);
    expect(suggestion.keep).toBe(keepFromTypeIn(175));
    expect(suggestion.pair).toBe(pairFromTypeIn(175));
    expect(suggestion.stance).toBe("at");
    expect(suggestion.label).toContain("no bigger or softer mark");
  });

  it("sits about 10% above the middle on a bigger game more than three weeks out", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 180,
      daysOut: 30,
      demand: "bigger",
    });
    expect(suggestion.typeIn).toBe(200);
    expect(suggestion.stance).toBe("above");
    expect(suggestion.label).toContain("10%");
  });

  it("keeps a bigger game on the middle once tip is inside three weeks", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 180,
      daysOut: 21,
      demand: "bigger",
    });
    expect(suggestion.typeIn).toBe(180);
    expect(suggestion.stance).toBe("at");
  });

  it("steps a softer game about 5% under the middle inside two weeks", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 200,
      daysOut: 14,
      demand: "soft",
    });
    expect(suggestion.typeIn).toBe(190);
    expect(suggestion.stance).toBe("below");
    expect(suggestion.keep).toBe(180.5);
    expect(suggestion.label).toContain("5%");
  });

  it("does not step a softer game down before the two-week window", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 200,
      daysOut: 15,
      demand: "soft",
    });
    expect(suggestion.typeIn).toBe(199);
    expect(suggestion.stance).toBe("at");
  });

  it("turns a middle of $200 into type $199 and you-keep of $189.05", () => {
    const suggestion = suggestFromMedian({
      listedMedian: 200,
      daysOut: 10,
      demand: "standard",
    });
    expect(suggestion.typeIn).toBe(199);
    expect(suggestion.keep).toBe(189.05);
    expect(suggestion.pair).toBe(378.1);
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
      listedMedian: 200,
      compCount: 6,
      excludedDump: true,
      daysOut: 10,
      demand: null,
      savedTypeIn: 151,
    });
    expect(view.suggestion?.typeIn).toBe(199);
    expect(view.typeIn).toBe(151);
    expect(view.keep).toBe(keepFromTypeIn(151));
    expect(view.usingOwn).toBe(true);
  });

  it("does not replace his number when the days or the middle change", () => {
    const far = resolveSeatPrice({
      listedMedian: 180,
      compCount: 4,
      excludedDump: false,
      daysOut: 40,
      demand: "bigger",
      savedTypeIn: 49,
    });
    const close = resolveSeatPrice({
      listedMedian: 240,
      compCount: 8,
      excludedDump: false,
      daysOut: 3,
      demand: "soft",
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
      listedMedian: null,
      compCount: null,
      excludedDump: false,
      daysOut: 13,
      demand: demandOf(row),
      savedTypeIn: null,
    });
    expect(view.suggestion).toBeNull();
    expect(view.typeIn).toBeNull();
  });

  it("uses zone_median when the stored book has no comp_median", () => {
    const stored = game({
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
    expect(view.typeIn).toBe(160);
    expect(view.pair).not.toBeNull();

    const withComp = game({
      date: "2026-10-23",
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
