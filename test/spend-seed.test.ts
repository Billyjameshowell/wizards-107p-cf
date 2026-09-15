import { describe, expect, it } from "vitest";
import { apifyInputForContext, apifyRunCost } from "../worker/adapters/apify";
import { seatDataCaps, seatDataPullCost } from "../worker/adapters/seatdata";
import { parseFlags } from "@shared/guardrails";

describe("adapter spend accounting", () => {
  it("uses SeatData's billing signal and estimates only when it is absent", () => {
    expect(seatDataPullCost(1)).toEqual({ actualUsd: 0.04, estimatedUsd: 0 });
    expect(seatDataPullCost(0)).toEqual({ actualUsd: 0, estimatedUsd: 0 });
    expect(seatDataPullCost(undefined)).toEqual({ actualUsd: 0, estimatedUsd: 0.04 });
  });

  it("uses terminal Apify usage as actual and keeps a reservation estimate otherwise", () => {
    expect(apifyRunCost(0.17, "SUCCEEDED", 0.5)).toEqual({ actualUsd: 0.17, estimatedUsd: 0 });
    expect(apifyRunCost(0, "RUNNING", 0.5)).toEqual({ actualUsd: 0, estimatedUsd: 0.5 });
    expect(apifyRunCost(undefined, "FAILED", 0.5)).toEqual({ actualUsd: 0, estimatedUsd: 0.5 });
  });
});

describe("one-shot seed adapter mode", () => {
  const flags = parseFlags({
    SEATDATA_MAX_PULLS_PER_RUN: "9",
    SEATDATA_MAX_PULLS_PER_ET_DAY: "11",
    APIFY_INCLUDE_LISTINGS: "true",
  });

  it("raises SeatData caps only when the caller has claimed seed mode", () => {
    expect(seatDataCaps(false, flags)).toEqual({ maxPerRun: 9, maxPerDay: 11 });
    expect(seatDataCaps(true, flags)).toEqual({ maxPerRun: 50, maxPerDay: 100 });
  });

  it("forces Apify listings off for seed mode", () => {
    expect(apifyInputForContext(flags, false).includeListings).toBe(true);
    expect(apifyInputForContext(flags, true).includeListings).toBe(false);
    expect(apifyInputForContext(flags, true).maxResults).toBe(50);
  });
});
