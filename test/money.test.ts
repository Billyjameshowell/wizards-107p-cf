import { describe, expect, it } from "vitest";
import { money } from "../src/lib/money";

describe("money", () => {
  it("drops cents only when there are none", () => {
    expect(money(57)).toBe("$57");
    expect(money(28.5)).toBe("$28.50");
    expect(money(12255)).toBe("$12,255");
    expect(money(89.83)).toBe("$89.83");
  });

  it("shows a dash for missing values", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(Number.NaN)).toBe("—");
  });
});
