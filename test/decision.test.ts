import { describe, expect, it } from "vitest";
import { pairDecision, priceKindFor, saleChanceSentence } from "@shared/decision";

describe("pairDecision", () => {
  it("says how a list sits against the cheapest of several 107 pairs, and the buyer total", () => {
    const decision = pairDecision({
      ours: 75,
      kind: "list",
      cheapest: 32,
      sectionCount: 8,
      neighborCount: 3,
    });
    expect(decision).toEqual({
      gap: "Your $75 list is $43 over the cheapest of 8 pairs in section 107.",
      board: null,
      buyer: "Buyers on Ticketmaster would see about $92.",
      floor: null,
    });
  });

  it("uses the price on the card, including one he typed", () => {
    const decision = pairDecision({
      ours: 80.4,
      kind: "price",
      cheapest: 88,
      sectionCount: null,
      neighborCount: null,
    });
    expect(decision?.gap).toBe("Your $80 price is $8 under the cheapest pair in section 107.");
    expect(decision?.buyer).toBe("Buyers on Ticketmaster would see about $98.");
  });

  it("says when the ask matches the only pair, and names the next sections", () => {
    const decision = pairDecision({
      ours: 70,
      kind: "ask",
      cheapest: 70,
      sectionCount: 1,
      neighborCount: 4,
    });
    expect(decision?.gap).toBe("The $70 ask matches the only pair in section 107.");
    expect(decision?.board).toBe(
      "Section 107 has one pair, so the ask also uses 4 pairs in sections 108, 118 and 119.",
    );
    expect(decision?.floor).toBe("That is under the $75 floor, which is not added into the ask.");
  });

  it("explains an empty section 107 without inventing a gap", () => {
    const decision = pairDecision({
      ours: 44,
      kind: "ask",
      cheapest: null,
      sectionCount: 0,
      neighborCount: 1,
    });
    expect(decision?.gap).toBeNull();
    expect(decision?.board).toBe(
      "Section 107 has no pairs listed, so the ask uses 1 pair in sections 108, 118 and 119.",
    );
  });

  it("returns nothing when the card has no price", () => {
    expect(
      pairDecision({ ours: null, kind: "ask", cheapest: 32, sectionCount: 8, neighborCount: 0 }),
    ).toBeNull();
  });
});

describe("priceKindFor", () => {
  it("keeps a live listing as the list when it differs from the model ask", () => {
    expect(priceKindFor({ listed: true, listedAsk: 75, typeIn: 75, usingOwn: true })).toBe("list");
  });

  it("calls a number typed on this device a price", () => {
    expect(priceKindFor({ listed: true, listedAsk: 75, typeIn: 90, usingOwn: true })).toBe("price");
    expect(priceKindFor({ listed: false, listedAsk: null, typeIn: 90, usingOwn: true })).toBe("price");
  });

  it("calls the model number an ask when nothing is listed", () => {
    expect(priceKindFor({ listed: false, listedAsk: null, typeIn: 196, usingOwn: false })).toBe("ask");
  });
});

describe("saleChanceSentence", () => {
  it("stays a sentence at the rounded extremes", () => {
    expect(saleChanceSentence(0.66)).toBe("There is a 66% chance this pair sells before tip.");
    expect(saleChanceSentence(0.999)).toBe("The chance this pair sells before tip is over 99%.");
  });
});
