import { describe, expect, it } from "vitest";
import { ageLabel, buildFreshnessReport, checkedAgo, freshness, isStaleCheck, latestOf } from "../src/shared/freshness";
import { freshnessResponse } from "../worker/freshness";

const NOW = new Date("2026-10-13T23:00:00Z");

describe("freshness", () => {
  it("is green under a day, amber to three days, red after or never", () => {
    expect(freshness("2026-10-13T20:00:00Z", NOW)).toEqual({ tone: "fresh", label: "3h ago", hours: 3 });
    expect(freshness("2026-10-12T12:00:00Z", NOW).tone).toBe("aging");
    expect(freshness("2026-10-12T12:00:00Z", NOW).label).toBe("35h ago");
    expect(freshness("2026-10-09T12:00:00Z", NOW)).toMatchObject({ tone: "stale", label: "4 days ago" });
    expect(freshness(null, NOW)).toEqual({ tone: "stale", label: "never", hours: null });
    expect(freshness("garbage", NOW).label).toBe("never");
  });

  it("reads a bare day and labels short ages", () => {
    expect(freshness("2026-10-13", NOW).tone).toBe("fresh");
    expect(ageLabel(0.01)).toBe("just now");
    expect(ageLabel(0.2)).toBe("12m ago");
    expect(ageLabel(1)).toBe("1h ago");
    expect(ageLabel(71.9)).toBe("71h ago");
    expect(ageLabel(72)).toBe("3 days ago");
    expect(ageLabel(272)).toBe("11 days ago");
    expect(ageLabel(24 * 90 + 5)).toBe("90 days ago");
    expect(latestOf([null, "2026-10-12T00:00:00Z", "2026-10-13T01:00:00Z", undefined])).toBe("2026-10-13T01:00:00Z");
    expect(latestOf([])).toBeNull();
  });

  it("labels a checked-ago badge in hours and marks 72h or never as stale", () => {
    expect(checkedAgo("2026-10-13T20:00:00Z", NOW)).toMatchObject({ tone: "fresh", label: "checked 3h ago" });
    expect(checkedAgo("2026-10-13T22:30:00Z", NOW).label).toBe("checked 30m ago");
    expect(checkedAgo("2026-10-13T22:59:50Z", NOW).label).toBe("checked just now");
    expect(checkedAgo("2026-10-02T15:00:00Z", NOW).label).toBe("checked 11 days ago");
    expect(checkedAgo("2026-10-12T12:00:00Z", NOW)).toMatchObject({ tone: "aging", label: "checked 35h ago" });
    expect(checkedAgo(null, NOW)).toEqual({ tone: "stale", label: "never checked", hours: null });
    expect(isStaleCheck("2026-10-10T23:00:00Z", NOW)).toBe(true);
    expect(isStaleCheck("2026-10-11T00:00:00Z", NOW)).toBe(false);
    expect(isStaleCheck(null, NOW)).toBe(true);
  });

  it("builds a public per-game and per-source freshness report", () => {
    const report = buildFreshnessReport({
      now: NOW,
      games: [
        { date: "2026-12-04", opponent: "TBD (NBA Cup week)", comp_checked_at: null },
        { date: "2026-10-21", opponent: "Milwaukee Bucks", comp_checked_at: "2026-10-13T20:00:00Z" },
      ],
      sourceCheckedAt: { seatdata: "2026-10-13T20:00:00Z", apify: null },
    });
    expect(report.staleAfterHours).toBe(72);
    expect(report.asof).toBe(NOW.toISOString());
    expect(report.sources).toEqual([
      { source: "seatdata", lastCheckedAt: "2026-10-13T20:00:00Z", ageHours: 3, stale: false },
      { source: "apify", lastCheckedAt: null, ageHours: null, stale: true },
    ]);
    expect(report.games).toEqual([
      {
        date: "2026-10-21",
        opponent: "Milwaukee Bucks",
        lastCheckedAt: "2026-10-13T20:00:00Z",
        ageHours: 3,
        stale: false,
      },
      {
        date: "2026-12-04",
        opponent: "TBD (NBA Cup week)",
        lastCheckedAt: null,
        ageHours: null,
        stale: true,
      },
    ]);
  });
});

describe("GET /api/freshness", () => {
  it("is public JSON and does not require a bearer token", async () => {
    const response = await freshnessResponse({} as Env, new Request("https://book.example/api/freshness"), NOW);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      games: { stale: boolean }[];
      sources: { source: string; stale: boolean }[];
    };
    expect(body.games).toHaveLength(43);
    expect(body.games.every((game) => game.stale)).toBe(true);
    expect(body.sources.map((source) => source.source)).toEqual(["seatdata", "apify"]);
    expect(body.sources.every((source) => source.stale)).toBe(true);

    const denied = await freshnessResponse(
      {} as Env,
      new Request("https://book.example/api/freshness", { method: "POST" }),
      NOW,
    );
    expect(denied.status).toBe(405);
  });
});
