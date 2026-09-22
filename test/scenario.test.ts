import { describe, expect, it } from "vitest";
import type { Game } from "@shared/book";
import { parseScenario, scenarioChoice, scenarioSummary, withScenarioChoice } from "@/lib/scenario";

function game(partial: Partial<Game> & Pick<Game, "date" | "sit_or_sell">): Game {
  return {
    weekday: "Sat",
    time_et: "7:00 PM",
    opponent: partial.date,
    type: "regular",
    advised_ask: null,
    cash_both_after_fee: null,
    listed: false,
    listed_ask: null,
    sold: false,
    notes: "",
    ticketdata_url: null,
    ...partial,
  };
}

describe("scenario planner", () => {
  const games = [
    game({ date: "2026-10-21", sit_or_sell: "Sit", cash_both_after_fee: 500, opponent: "Bucks" }),
    game({ date: "2026-10-23", sit_or_sell: "Sell", cash_both_after_fee: 180, opponent: "Raptors" }),
    game({ date: "2026-10-30", sit_or_sell: "Sell", cash_both_after_fee: null, opponent: "Hornets" }),
    game({ date: "2026-11-02", sit_or_sell: "TBD", cash_both_after_fee: 90, opponent: "Magic" }),
  ];

  it("starts from the book and counts only Sell cash", () => {
    const summary = scenarioSummary(games, {}, 6000);
    expect(scenarioChoice(games[0], {})).toBe("Sit");
    expect(scenarioChoice(games[1], {})).toBe("Sell");
    expect(summary.sellCash).toBe(180);
    expect(summary.vsSeason).toBe(-5820);
    expect(summary.sellCount).toBe(2);
    expect(summary.sitCount).toBe(1);
    expect(summary.tbdCount).toBe(1);
  });

  it("adds cash when a Sit game is toggled to Sell and drops it when flipped back", () => {
    const selling = withScenarioChoice(games, {}, "2026-10-21", "Sell");
    expect(selling).toEqual({ "2026-10-21": "Sell" });
    const sold = scenarioSummary(games, selling, 6000);
    expect(sold.sellCash).toBe(680);
    expect(sold.sellCount).toBe(3);
    expect(sold.sitCount).toBe(0);

    const back = withScenarioChoice(games, selling, "2026-10-21", "Sit");
    expect(back).toEqual({});
    expect(scenarioSummary(games, back, 5000).vsSeason).toBe(-4820);
  });

  it("does not count a Sell game that is toggled to Sit", () => {
    const sitting = withScenarioChoice(games, {}, "2026-10-23", "Sit");
    const summary = scenarioSummary(games, sitting, 6000);
    expect(summary.sellCash).toBe(0);
    expect(summary.sitCount).toBe(2);
    expect(summary.sellCount).toBe(1);
  });

  it("ignores stored values that are not Sit or Sell", () => {
    expect(parseScenario({ "2026-10-21": "Sit", "2026-10-23": "Listed", nope: 1 })).toEqual({
      "2026-10-21": "Sit",
    });
    expect(parseScenario(null)).toEqual({});
  });
});
