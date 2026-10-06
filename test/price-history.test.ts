import { describe, expect, it } from "vitest";
import type { Book, Game } from "@shared/book";
import { keepFromTypeIn, pairFromTypeIn } from "@shared/book";
import {
  blendCompHistory,
  compHistoryFromRows,
  compHistoryNote,
  mergeToday,
  orderGamesForCompPull,
  type CompObservation,
} from "@shared/price-history";
import { resolveSeatPrice, seriousCompMedian, suggestFromMedian } from "@shared/pricing";
import { prioritizeDates } from "../worker/adapters/seatdata";
import { mergeBook } from "../worker/ingest";

const NOW = new Date("2026-10-06T16:00:00.000Z");

function daysAgo(days: number, hours = 0): string {
  return new Date(NOW.getTime() - (days * 86_400_000 + hours * 3_600_000)).toISOString();
}

function obs(
  days: number,
  etDate: string,
  median: number | null,
  compCount: number,
  extra: Partial<CompObservation> = {},
): CompObservation {
  return {
    pulledAt: daysAgo(days),
    etDate,
    median,
    compCount,
    excludedDump: false,
    ...extra,
  };
}

function game(partial: Partial<Game> = {}): Game {
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
    notes: "keep me",
    ticketdata_url: null,
    ...partial,
  };
}

function book(partial: Partial<Game> = {}): Book {
  return {
    asof_et: "",
    sell_book_cash: 0,
    vs_6k: -6000,
    season_cost: 6000,
    section: "107",
    row: "P",
    seats: [1, 2],
    list_nothing_until_billy_says: true,
    games: [game(partial)],
  };
}

describe("blendCompHistory", () => {
  it("uses the first check as-is", () => {
    const blend = blendCompHistory([obs(0, "2026-10-06", 176.4, 5)], NOW);
    expect(blend.median).toBe(176.4);
    expect(blend.pulls).toBe(1);
    expect(blend.heldPrior).toBe(false);
    expect(blend.confidence).toBe("building");
  });

  it("keeps a thin morning close to the recent middle", () => {
    const blend = blendCompHistory(
      [obs(7, "2026-09-29", 200, 8), obs(0, "2026-10-06", 140, 2)],
      NOW,
    );
    expect(blend.median).toBe(180);
    expect(blend.confidence).toBe("thin");
    expect(blend.median).not.toBe(140);
  });

  it("follows a busy morning most of the way without taking the whole jump", () => {
    const thin = blendCompHistory(
      [obs(7, "2026-09-29", 200, 8), obs(0, "2026-10-06", 140, 2)],
      NOW,
    );
    const rich = blendCompHistory(
      [obs(7, "2026-09-29", 200, 8), obs(0, "2026-10-06", 140, 12)],
      NOW,
    );
    expect(rich.median).toBe(155);
    expect(rich.confidence).toBe("building");
    expect(rich.median).toBeLessThan(thin.median ?? 0);
    expect(rich.median).toBeGreaterThan(140);
    expect(rich.median).toBeLessThan(170);
  });

  it("weights a week-old check at half when mixing two earlier middles", () => {
    const blend = blendCompHistory(
      [
        obs(14, "2026-09-22", 100, 8),
        obs(7, "2026-09-29", 200, 8),
        obs(0, "2026-10-06", 200, 8),
      ],
      NOW,
    );
    // Prior weights: 8 * 0.25 for the two-week check, 8 * 0.5 for the one-week check.
    // Prior = (100 * 2 + 200 * 4) / 6 = 166.666..., trust = 8/12.
    expect(blend.median).toBe(188.89);
    expect(blend.pulls).toBe(3);
  });

  it("nudges further along a steady busy move than a jumpy series", () => {
    const rising = blendCompHistory(
      [
        obs(14, "2026-09-22", 160, 8),
        obs(7, "2026-09-29", 180, 8),
        obs(0, "2026-10-06", 200, 8),
      ],
      NOW,
    );
    const jumpy = blendCompHistory(
      [
        obs(14, "2026-09-22", 180, 8),
        obs(7, "2026-09-29", 160, 8),
        obs(0, "2026-10-06", 200, 8),
      ],
      NOW,
    );
    expect(rising.median).toBeGreaterThan(jumpy.median ?? 0);
    expect(rising.median).toBeLessThan(200);
    expect(rising.confidence).toBe("solid");
    expect(rising.pulls).toBe(3);
  });

  it("holds the recent middle when this morning has no usable comps", () => {
    const blend = blendCompHistory(
      [obs(3, "2026-10-03", 175, 5), obs(0, "2026-10-06", null, 0)],
      NOW,
    );
    expect(blend.median).toBe(175);
    expect(blend.heldPrior).toBe(true);
    expect(blend.compCount).toBe(0);
    expect(blend.pulls).toBe(1);
  });

  it("drops a stale middle after three weeks with nothing new", () => {
    const blend = blendCompHistory(
      [obs(22, "2026-09-14", 175, 6), obs(0, "2026-10-06", null, 0)],
      NOW,
    );
    expect(blend.median).toBeNull();
    expect(blend.heldPrior).toBe(false);
  });

  it("lets a same-day rerun replace that morning instead of counting it twice", () => {
    const blend = blendCompHistory(
      [
        {
          pulledAt: daysAgo(0, 2),
          etDate: "2026-10-06",
          median: 200,
          compCount: 8,
        },
        obs(0, "2026-10-06", 140, 8),
      ],
      NOW,
    );
    expect(blend.median).toBe(140);
    expect(blend.pulls).toBe(1);
    const merged = mergeToday(
      [{ pulledAt: daysAgo(0, 2), etDate: "2026-10-06", median: 200, compCount: 8 }],
      obs(0, "2026-10-06", 140, 8),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.median).toBe(140);
  });

  it("ignores a check older than the window", () => {
    const blend = blendCompHistory(
      [obs(46, "2026-08-21", 200, 10), obs(0, "2026-10-06", 150, 8)],
      NOW,
    );
    expect(blend.median).toBe(150);
    expect(blend.pulls).toBe(1);
  });
});

describe("lone cheap 107P", () => {
  it("never becomes the middle, and a one-listing outlier cannot replace a real one", () => {
    const onlyDump = seriousCompMedian([
      { active: true, section: "107", row: "P", quantity: 2, price: 40 },
    ]);
    expect(onlyDump.median).toBeNull();
    expect(onlyDump.excludedDump).toBe(true);
    expect(onlyDump.count).toBe(0);

    const withRealSeats = seriousCompMedian([
      { active: true, section: "107", row: "P", quantity: 2, price: 40 },
      { active: true, section: "107", row: "P", quantity: 2, price: 180 },
      { active: true, section: "108", row: "K", quantity: 2, price: 165 },
      { active: true, section: "119", row: "T", quantity: 2, price: 210 },
    ]);
    expect(withRealSeats.excludedDump).toBe(true);
    expect(withRealSeats.median).toBe(180);
    expect(withRealSeats.median).not.toBe(40);

    const held = blendCompHistory(
      [obs(3, "2026-10-03", 180, 6), obs(0, "2026-10-06", onlyDump.median, onlyDump.count, { excludedDump: true })],
      NOW,
    );
    expect(held.median).toBe(180);
    expect(held.heldPrior).toBe(true);
    expect(held.excludedDump).toBe(true);

    const thinOutlier = blendCompHistory(
      [obs(7, "2026-09-29", 180, 8), obs(0, "2026-10-06", 50, 1)],
      NOW,
    );
    expect(thinOutlier.median).toBe(154);
    expect(thinOutlier.median).not.toBe(50);
    expect(thinOutlier.median).toBeGreaterThan(140);

    const suggestion = suggestFromMedian({
      listedMedian: held.median ?? 0,
      daysOut: 10,
      demand: null,
      compCount: held.compCount,
      excludedDump: held.excludedDump,
    });
    expect(suggestion.typeIn).not.toBe(40);
    expect(suggestion.typeIn).not.toBe(50);
    expect(suggestion.listedMedian).toBe(180);
  });
});

describe("arena prices stay out of the ask", () => {
  it("drops Apify rows when building comp history", () => {
    const history = compHistoryFromRows([
      {
        gameDate: "2026-10-12",
        source: "apify",
        etDate: "2026-10-06",
        pulledAt: NOW.toISOString(),
        median: 30,
        compCount: 80,
        excludedDump: false,
      },
      {
        gameDate: "2026-10-12",
        source: "seatdata",
        etDate: "2026-10-06",
        pulledAt: NOW.toISOString(),
        median: 180,
        compCount: 4,
        excludedDump: false,
      },
    ]);
    const pulls = history.get("2026-10-12") ?? [];
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.median).toBe(180);
  });
});

describe("comp history note", () => {
  it("stays quiet on the first check and says when a thin morning disagrees", () => {
    expect(
      compHistoryNote({
        pulls: 1,
        confidence: "building",
        heldPrior: false,
        snapshotMedian: 180,
        blendedMedian: 180,
      }),
    ).toBeNull();
    expect(
      compHistoryNote({
        pulls: 3,
        confidence: "thin",
        heldPrior: false,
        snapshotMedian: 100,
        blendedMedian: 180,
      }),
    ).toBe(
      "Few similar seats are listed, so this stays close to recent prices. Today they are listed around $100.00.",
    );
    expect(
      compHistoryNote({
        pulls: 4,
        confidence: "solid",
        heldPrior: false,
        snapshotMedian: 181,
        blendedMedian: 180,
      }),
    ).toBe("A lot of similar seats are listed, so this follows the recent market.");
    expect(
      compHistoryNote({
        pulls: 3,
        confidence: "building",
        heldPrior: true,
        snapshotMedian: null,
        blendedMedian: 175,
      }),
    ).toBeNull();
  });
});

describe("which games get the next check", () => {
  it("looks at an unchecked game before one already checked", () => {
    const dates = prioritizeDates(
      [
        game({ date: "2026-10-01", opponent: "past" }),
        game({ date: "2026-12-04", opponent: "cup", sit_or_sell: "TBD" }),
        game({
          date: "2026-10-12",
          comp_checked_at: "2026-10-06T12:00:00.000Z",
        }),
        game({ date: "2027-03-06", opponent: "Utah Jazz" }),
        game({ date: "2026-10-21", opponent: "Bucks", sit_or_sell: "Sit" }),
      ],
      NOW,
    );
    expect(dates[0]).toBe("2027-03-06");
    expect(dates).not.toContain("2026-10-01");
    expect(dates).not.toContain("2026-12-04");
    expect(dates.indexOf("2026-10-21")).toBeLessThan(dates.indexOf("2026-10-12"));
  });

  it("refreshes a game near tip ahead of a far game, unless the far game has waited much longer", () => {
    const closeFirst = orderGamesForCompPull(
      [
        {
          date: "2026-11-20",
          sit_or_sell: "Sell",
          comp_checked_at: daysAgo(0, 40),
        },
        {
          date: "2026-10-10",
          sit_or_sell: "Sell",
          comp_checked_at: daysAgo(0, 30),
        },
      ],
      NOW,
    );
    expect(closeFirst.map((item) => item.date)).toEqual(["2026-10-10", "2026-11-20"]);

    const neglectedFar = orderGamesForCompPull(
      [
        {
          date: "2026-11-20",
          sit_or_sell: "Sell",
          comp_checked_at: daysAgo(0, 100),
        },
        {
          date: "2026-10-10",
          sit_or_sell: "Sell",
          comp_checked_at: daysAgo(0, 1),
        },
      ],
      NOW,
    );
    expect(neglectedFar.map((item) => item.date)).toEqual(["2026-11-20", "2026-10-10"]);
  });
});

describe("mergeBook", () => {
  it("blends the band and does not let an arena median or a typed field move", () => {
    const blended = mergeBook(
      book(),
      [
        {
          source: "seatdata",
          paid: true,
          points: [{ date: "2026-10-12", compMedian: 140, compCount: 2, compExcludedDump: false }],
        },
        {
          source: "apify",
          paid: true,
          points: [{ date: "2026-10-12", getIn: 30, median: 40, listingCount: 100 }],
        },
      ],
      NOW,
      new Map([
        ["2026-10-12", [obs(7, "2026-09-29", 200, 8)]],
      ]),
    );
    const row = blended.games[0];
    expect(row?.comp_median).toBe(180);
    expect(row?.comp_snapshot_median).toBe(140);
    expect(row?.market_median).toBe(40);
    expect(row?.market_get_in).toBe(30);
    expect(row?.advised_ask).toBeNull();
    expect(row?.notes).toBe("keep me");
    expect(row?.sit_or_sell).toBe("Sell");
    expect(row?.comp_checked_at).toBe(NOW.toISOString());
  });

  it("keeps a stored middle when this morning is empty and history could not be read", () => {
    const next = mergeBook(
      book({ comp_median: 180, comp_pulls: 2, comp_confidence: "building" }),
      [
        {
          source: "seatdata",
          paid: true,
          points: [{ date: "2026-10-12", compMedian: null, compCount: 0, compExcludedDump: true }],
        },
      ],
      NOW,
    );
    expect(next.games[0]?.comp_median).toBe(180);
    expect(next.games[0]?.comp_held_prior).toBe(true);
    expect(next.games[0]?.comp_excluded_dump).toBe(true);
    expect(next.games[0]?.advised_ask).toBeNull();
  });

  it("does not let Apify replace a comp middle", () => {
    const next = mergeBook(
      book({ comp_median: 180 }),
      [
        {
          source: "apify",
          paid: true,
          points: [{ date: "2026-10-12", median: 40, getIn: 25, listingCount: 90 }],
        },
      ],
      NOW,
    );
    expect(next.games[0]?.comp_median).toBe(180);
    expect(next.games[0]?.market_median).toBe(40);
  });
});

describe("suggestion still follows the day rules and a saved type-in", () => {
  it("applies the far-out bigger-game step to the blended middle, not a thin spike", () => {
    const blend = blendCompHistory(
      [obs(7, "2026-09-29", 200, 8), obs(0, "2026-10-06", 100, 1)],
      NOW,
    );
    expect(blend.median).toBe(180);
    const steady = suggestFromMedian({
      listedMedian: blend.median ?? 0,
      daysOut: 30,
      demand: "bigger",
    });
    const spike = suggestFromMedian({ listedMedian: 100, daysOut: 30, demand: "bigger" });
    expect(steady.typeIn).toBe(200);
    expect(steady.keep).toBe(keepFromTypeIn(200));
    expect(steady.pair).toBe(pairFromTypeIn(200));
    expect(steady.stance).toBe("above");
    expect(spike.typeIn).not.toBe(steady.typeIn);
    expect(steady.keep).toBe(190);
  });

  it("keeps a typed price when the blended middle and the days change", () => {
    const view = resolveSeatPrice({
      listedMedian: 180,
      compCount: 6,
      excludedDump: false,
      daysOut: 30,
      demand: "bigger",
      savedTypeIn: 49,
      pulls: 4,
      confidence: "solid",
      heldPrior: false,
      snapshotMedian: 170,
    });
    expect(view.typeIn).toBe(49);
    expect(view.keep).toBe(46.55);
    expect(view.suggestion?.typeIn).toBe(200);
    expect(view.suggestion?.historyNote).toContain("recent market");
    expect(view.usingOwn).toBe(true);
  });
});
