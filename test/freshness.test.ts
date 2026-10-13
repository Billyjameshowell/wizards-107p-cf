import { describe, expect, it } from "vitest";
import { ageLabel, freshness, latestOf } from "../src/shared/freshness";

const NOW = new Date("2026-10-13T23:00:00Z");

describe("freshness", () => {
  it("is green under a day, amber to three days, red after or never", () => {
    expect(freshness("2026-10-13T20:00:00Z", NOW)).toEqual({ tone: "fresh", label: "3h ago", hours: 3 });
    expect(freshness("2026-10-12T12:00:00Z", NOW).tone).toBe("aging");
    expect(freshness("2026-10-12T12:00:00Z", NOW).label).toBe("1 day ago");
    expect(freshness("2026-10-09T12:00:00Z", NOW)).toMatchObject({ tone: "stale", label: "4 days ago" });
    expect(freshness(null, NOW)).toEqual({ tone: "stale", label: "never", hours: null });
    expect(freshness("garbage", NOW).label).toBe("never");
  });

  it("reads a bare day and labels short ages", () => {
    expect(freshness("2026-10-13", NOW).tone).toBe("fresh");
    expect(ageLabel(0.2)).toBe("just now");
    expect(latestOf([null, "2026-10-12T00:00:00Z", "2026-10-13T01:00:00Z", undefined])).toBe("2026-10-13T01:00:00Z");
    expect(latestOf([])).toBeNull();
  });
});
