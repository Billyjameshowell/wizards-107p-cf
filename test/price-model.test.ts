import { describe, expect, it } from "vitest";
import {
  MAX_PACE_MOVE,
  MIN_POINTS,
  MIN_SPAN_DAYS,
  NOT_ENOUGH_DATA,
  projectTipPrice,
  type GameFeatures,
  type PriceObservation,
} from "@shared/price-model";

function game(daysOut: number, extras: Partial<GameFeatures> = {}): GameFeatures {
  return {
    date: "2026-10-21",
    opponent: "Milwaukee Bucks",
    type: "regular",
    weekday: "Wed",
    daysOut,
    ...extras,
  };
}

function point(date: string, median: number, daysOut = 30): PriceObservation {
  return { date, daysOut, median, cheapest: null };
}

describe("projectTipPrice", () => {
  it("refuses a short series", () => {
    const thin = projectTipPrice(
      [point("2026-09-01", 200, 50), point("2026-09-15", 184, 36)],
      game(14),
    );
    expect(thin.enough).toBe(false);
    expect(thin.price).toBeNull();
    expect(thin.low).toBeNull();
    expect(thin.high).toBeNull();
    expect(thin.sentence).toBe(NOT_ENOUGH_DATA);
    expect(MIN_POINTS).toBe(3);
    expect(MIN_SPAN_DAYS).toBe(7);
  });

  it("refuses three checks that span less than a week", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 200), point("2026-09-03", 196), point("2026-09-06", 190)],
      game(14),
    );
    expect(result.enough).toBe(false);
    expect(result.sentence).toBe(NOT_ENOUGH_DATA);
  });

  it("extends an 8% drop over two weeks into a game-day price and a range", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 200, 50), point("2026-09-08", 196, 43), point("2026-09-15", 184, 36)],
      game(14),
    );
    expect(result.enough).toBe(true);
    expect(result.price).toBe(169);
    expect(result.low).not.toBeNull();
    expect(result.high).not.toBeNull();
    expect(result.low!).toBeLessThanOrEqual(result.price!);
    expect(result.high!).toBeGreaterThanOrEqual(result.price!);
    expect(result.sentence).toBe(
      "Prices for this game have dropped 8% in 2 weeks; at this pace they'd be around $169 by game day.",
    );
  });

  it("says when prices have risen", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 150, 40), point("2026-09-08", 156, 33), point("2026-09-15", 162, 26)],
      game(7),
    );
    expect(result.enough).toBe(true);
    expect(result.sentence).toMatch(/^Prices for this game have risen \d+% in /);
    expect(result.sentence).toContain("by game day");
    expect(result.price).toBeGreaterThan(162);
  });

  it("says when prices have held steady", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 180, 40), point("2026-09-08", 180, 33), point("2026-09-15", 180.2, 26)],
      game(14),
    );
    expect(result.enough).toBe(true);
    expect(result.sentence).toMatch(/held steady over /);
  });

  it("refuses a pace that would swing the price by more than half before tip", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 200, 220), point("2026-09-08", 190, 213), point("2026-09-15", 160, 206)],
      game(200),
    );
    expect(result.enough).toBe(false);
    expect(result.price).toBeNull();
    expect(result.sentence).toBe(NOT_ENOUGH_DATA);
    expect(MAX_PACE_MOVE).toBe(0.5);
  });

  it("does not invent a price after tip", () => {
    const result = projectTipPrice(
      [point("2026-09-01", 200, 20), point("2026-09-08", 190, 13), point("2026-09-15", 184, 6)],
      game(-2),
    );
    expect(result.enough).toBe(false);
    expect(result.price).toBeNull();
    expect(result.sentence).toBe("This game has already tipped.");
  });

  it("accepts game features the placeholder does not need yet", () => {
    const series = [
      point("2026-09-01", 200, 50),
      point("2026-09-08", 196, 43),
      point("2026-09-15", 184, 36),
    ];
    const bucks = projectTipPrice(series, game(14));
    const knicks = projectTipPrice(
      series,
      game(14, { opponent: "New York Knicks", type: "preseason", weekday: "Fri", date: "2026-12-18" }),
    );
    expect(knicks.price).toBe(bucks.price);
    expect(knicks.sentence).toBe(bucks.sentence);
  });
});
