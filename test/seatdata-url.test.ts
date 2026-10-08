import { describe, expect, it } from "vitest";
import { buildSeatdataUrl } from "../worker/adapters/seatdata";
import { parseFlags } from "@shared/guardrails";

describe("SeatData URL building", () => {
  it("builds search and listings URLs under https://seatdata.io/api (not api.seatdata.io)", () => {
    const base = "https://seatdata.io";
    expect(
      buildSeatdataUrl(base, "/api/v1/events/search", {
        venue_name: "Capital One Arena",
        event_name: "Washington Wizards",
        limit: "200",
      }),
    ).toBe(
      "https://seatdata.io/api/v1/events/search?venue_name=Capital+One+Arena&event_name=Washington+Wizards&limit=200",
    );
    expect(buildSeatdataUrl(base, "/api/v0.1.1/listings/get", { event_id: "12345" })).toBe(
      "https://seatdata.io/api/v0.1.1/listings/get?event_id=12345",
    );
  });

  it("does not drop /api when the base includes a trailing slash", () => {
    expect(buildSeatdataUrl("https://seatdata.io/", "/api/v1/events/search")).toBe(
      "https://seatdata.io/api/v1/events/search",
    );
  });

  it("defaults SEATDATA_BASE_URL to https://seatdata.io", () => {
    const flags = parseFlags({});
    expect(flags.seatdataBaseUrl).toBe("https://seatdata.io");
    expect(flags.seatdataBaseUrl).not.toContain("api.seatdata.io");
  });
});
