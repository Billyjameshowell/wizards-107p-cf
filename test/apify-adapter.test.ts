import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySpendState } from "@shared/guardrails";
import type { Game } from "@shared/book";
import {
  emptyRunNote,
  homePointsFromRows,
  rowSample,
  runApify,
  seatGeekEventPoint,
} from "../worker/adapters/apify";

/** Row shape from lentic_clockss/seatgeek-scraper 0.1.73 (listings is now a summary object). */
const lenticRow = {
  eventId: "17654321",
  title: "Milwaukee Bucks at Washington Wizards",
  datetimeLocal: "2026-10-21T19:00:00",
  datetimeUtc: "2026-10-21T23:00:00",
  venueSlug: "capital-one-arena",
  venueName: "Capital One Arena",
  performerNames: ["Washington Wizards", "Milwaukee Bucks"],
  lowestPrice: 18,
  medianPrice: 74,
  listingCount: 812,
  listings: { complete: false, filtered: false, total: 0, source: "aggregate" },
};

/** Row shape from ahmed_jasarevic/seatgeek-scraper (prices nested under priceRange). */
const ahmedRow = {
  recordType: "event",
  eventId: 17654399,
  title: "Toronto Raptors at Washington Wizards",
  datetimeLocal: "2026-10-23T19:00:00",
  venueName: "Capital One Arena",
  venueSlug: "capital-one-arena",
  primaryPerformer: "Washington Wizards",
  priceRange: { lowestPrice: 15, medianPrice: 61, listingCount: 640, currency: "USD", source: "seatgeek" },
};

const awayRow = {
  ...lenticRow,
  title: "Washington Wizards at Boston Celtics",
  datetimeLocal: "2026-10-25T19:30:00",
  venueSlug: "td-garden",
  venueName: "TD Garden",
};

describe("SeatGeek row mapping", () => {
  it("reads the flat lentic shape", () => {
    const point = seatGeekEventPoint(lenticRow);
    expect(point).toMatchObject({
      date: "2026-10-21",
      home: true,
      wizards: true,
      getIn: 18,
      median: 74,
      listingCount: 812,
    });
  });

  it("reads the nested priceRange shape", () => {
    expect(seatGeekEventPoint(ahmedRow)).toMatchObject({
      date: "2026-10-23",
      home: true,
      getIn: 15,
      median: 61,
      listingCount: 640,
    });
  });

  it("keeps home Wizards games only, one per date, and skips summary rows", () => {
    const capitalsGame = {
      ...lenticRow,
      title: "Pittsburgh Penguins at Washington Capitals",
      performerNames: ["Washington Capitals"],
      datetimeLocal: "2026-10-22T19:00:00",
    };
    const summary = { recordType: "summary", eventsProcessed: 3, scrapedAt: "2026-10-08T21:00:00Z" };
    const dupe = { ...lenticRow, lowestPrice: 999 };
    const points = homePointsFromRows([lenticRow, dupe, awayRow, capitalsGame, summary, ahmedRow]);
    expect(points.map((p) => p.date)).toEqual(["2026-10-21", "2026-10-23"]);
    expect(points[0]?.point.getIn).toBe(18);
  });
});

function env(overrides: Record<string, string> = {}): Env {
  return {
    INGEST_ENABLED: "true",
    DRY_RUN: "false",
    SOURCES: "apify",
    APIFY_TOKEN: "test-token",
    ...overrides,
  } as unknown as Env;
}

const games = [
  { date: "2026-10-21", opponent: "Bucks" },
  { date: "2026-10-23", opponent: "Raptors" },
] as unknown as Game[];

function mockApify(rows: unknown[], log = "INFO no upcoming events for performer") {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/runs?")) {
        return Response.json({
          data: {
            id: "run123",
            status: "SUCCEEDED",
            statusMessage: "done",
            buildNumber: "0.1.73",
            defaultDatasetId: "ds1",
            usageTotalUsd: 0.005,
          },
        });
      }
      if (url.includes("/datasets/ds1/items")) return Response.json(rows);
      if (url.endsWith("/actor-runs/run123/log")) return new Response(log);
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

describe("rowSample", () => {
  it("summarizes rows so an empty run explains itself in D1", () => {
    const text = rowSample([awayRow, { recordType: "runSummary", note: "done" }]);
    expect(text).toContain("2026-10-25T19:30:00 | td-garden | Washington Wizards at Boston Celtics");
    expect(text).toContain("runSummary | done");
  });
});

describe("emptyRunNote", () => {
  it("puts rows, status and the end of the log in one bounded line", () => {
    const longLog = `${"x".repeat(5000)}\nWARN   free tier: stopped after 0 events\n`;
    const text = emptyRunNote([{ recordType: "runSummary", eventsProcessed: 0, note: "done" }], {
      statusMessage: "Finished",
      logTail: longLog,
    });
    expect(text).toContain("rows: runSummary | eventsProcessed=0 | done");
    expect(text).toContain("status: Finished");
    expect(text).toContain("log: …");
    expect(text).toContain("WARN free tier: stopped after 0 events");
    expect(text.length).toBeLessThan(1400);
  });

  it("skips parts that are missing", () => {
    expect(emptyRunNote([], { statusMessage: null, logTail: "  " })).toBe("");
  });
});

describe("runApify", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps rows into home-game points and keeps the run row ok", async () => {
    const calls = mockApify([lenticRow, awayRow]);
    const out = await runApify(
      { env: env(), games, now: new Date("2026-10-08T21:00:00Z") },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(out.result.aborted).toBeUndefined();
    expect(out.result.points).toEqual([
      { date: "2026-10-21", getIn: 18, median: 74, listingCount: 812 },
    ]);
    expect(out.observations[0]).toMatchObject({ status: "ok", costUsd: 0.005, listingCount: 2 });
    expect(out.observations[1]).toMatchObject({ gameDate: "2026-10-21", opponent: "Bucks", status: "ok" });
    expect(calls[0]).toContain("/acts/ahmed_jasarevic~seatgeek-scraper/runs?");
    expect(calls[0]).not.toContain("build=");
    expect(calls.some((url) => url.endsWith("/log"))).toBe(false);
  });

  it("marks a zero-row run empty and archives the actor log tail", async () => {
    mockApify([]);
    const out = await runApify(
      { env: env(), games, now: new Date("2026-10-08T21:00:00Z") },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(out.result.points).toEqual([]);
    expect(out.result.aborted).toBe("zero_rows");
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]).toMatchObject({ status: "empty", error: "apify_zero_rows" });
    expect(out.observations[0]?.note).toContain("log: INFO no upcoming events for performer");
    expect(out.observations[0]?.note).toContain("status: done");
    const raw = out.observations[0]?.raw as { logTail: string; buildNumber: string };
    expect(raw.logTail).toContain("no upcoming events");
    expect(raw.buildNumber).toBe("0.1.73");
  });

  it("explains a run with only a summary row in the D1 note", async () => {
    mockApify([{ recordType: "runSummary", eventsProcessed: 0, note: "done" }], "INFO 0 events matched");
    const out = await runApify(
      { env: env(), games, now: new Date("2026-10-08T21:00:00Z") },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(out.result.aborted).toBe("no_home_rows");
    expect(out.observations[0]?.note).toContain("rows: runSummary | eventsProcessed=0 | done");
    expect(out.observations[0]?.note).toContain("log: INFO 0 events matched");
  });

  it("pins a build and switches actor from env", async () => {
    const calls = mockApify([lenticRow]);
    const out = await runApify(
      {
        env: env({ APIFY_ACTOR: "lentic_clockss~seatgeek-scraper", APIFY_ACTOR_BUILD: "0.1.72" }),
        games,
        now: new Date("2026-10-08T21:00:00Z"),
      },
      emptySpendState("2026-10-08"),
      "2026-10-08",
    );
    expect(calls[0]).toContain("/acts/lentic_clockss~seatgeek-scraper/runs?");
    expect(calls[0]).toContain("build=0.1.72");
    expect(calls[0]).toContain("maxTotalChargeUsd=0.50");
    expect(out.result.points).toEqual([
      { date: "2026-10-21", getIn: 18, median: 74, listingCount: 812 },
    ]);
  });
});
