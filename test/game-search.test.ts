import { describe, expect, it } from "vitest";
import { gameMatchesQuery, type GameSearchable } from "@/lib/game-search";

const raptors: GameSearchable = {
  date: "2026-10-23",
  weekday: "Fri",
  opponent: "Toronto Raptors",
  type: "regular",
  notes: "National TV",
  sitOrSell: "Sell",
};

const pistons: GameSearchable = {
  date: "2026-10-10",
  weekday: "Sat",
  opponent: "Detroit Pistons",
  type: "preseason",
  notes: "Preseason",
  sitOrSell: "Sit",
};

describe("gameMatchesQuery", () => {
  it("matches opponent, date, weekday, type, notes, and Sit or Sell", () => {
    expect(gameMatchesQuery(raptors, "raptors")).toBe(true);
    expect(gameMatchesQuery(raptors, "TORONTO")).toBe(true);
    expect(gameMatchesQuery(raptors, "Oct 23")).toBe(true);
    expect(gameMatchesQuery(raptors, "10/23")).toBe(true);
    expect(gameMatchesQuery(raptors, "2026-10-23")).toBe(true);
    expect(gameMatchesQuery(raptors, "friday")).toBe(true);
    expect(gameMatchesQuery(raptors, "regular")).toBe(true);
    expect(gameMatchesQuery(raptors, "national tv")).toBe(true);
    expect(gameMatchesQuery(raptors, "sell")).toBe(true);
    expect(gameMatchesQuery(pistons, "saturday")).toBe(true);
    expect(gameMatchesQuery(pistons, "preseason")).toBe(true);
    expect(gameMatchesQuery(pistons, "sit")).toBe(true);
  });

  it("ignores case and extra space, and a blank query keeps every game", () => {
    expect(gameMatchesQuery(raptors, "  oct   23 ")).toBe(true);
    expect(gameMatchesQuery(raptors, "   ")).toBe(true);
    expect(gameMatchesQuery(raptors, "")).toBe(true);
  });

  it("leaves out a game that does not match", () => {
    expect(gameMatchesQuery(raptors, "pistons")).toBe(false);
    expect(gameMatchesQuery(raptors, "10/24")).toBe(false);
    expect(gameMatchesQuery(raptors, "sit")).toBe(false);
    expect(gameMatchesQuery(pistons, "10/23")).toBe(false);
  });

  it("treats Sit and Sell as whole words, so visit does not count as Sit", () => {
    const visit = { ...raptors, notes: "LeBron first visit, Thursday — sell", sitOrSell: "Sell" };
    expect(gameMatchesQuery(visit, "sit")).toBe(false);
    expect(gameMatchesQuery(visit, "sell")).toBe(true);
    expect(gameMatchesQuery({ ...visit, sitOrSell: "Sit", notes: "LeBron first visit" }, "sit")).toBe(true);
  });
});
