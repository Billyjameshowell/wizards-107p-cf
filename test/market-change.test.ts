import { describe, expect, it } from "vitest";
import { percentChange, formatPercentChange } from "../src/shared/market-change";

describe("price changes", () => {
  it("uses the previous price as the denominator", () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(80, 100)).toBe(-20);
    expect(percentChange(100, 100)).toBe(0);
  });
  it("does not manufacture a change from missing, invalid, or zero baselines", () => {
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(100, 0)).toBeNull();
    expect(percentChange(Infinity, 100)).toBeNull();
    expect(percentChange(-1, 100)).toBeNull();
  });
  it("displays direction and handles rounding near zero", () => {
    expect(formatPercentChange(10)).toBe("+10.0%");
    expect(formatPercentChange(-20)).toBe("-20.0%");
    expect(formatPercentChange(-0.001)).not.toContain("-");
  });
});
