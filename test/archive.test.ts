import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LISTING_CSV_COLUMNS,
  listingsFromUnknown,
  parseExportQuery,
  planBookSnapshots,
  planLegacyArchive,
  planObservedPulls,
  planPriceHistoryArchive,
  pullFilter,
  toCsv,
  etStampToIso,
} from "@shared/archive";
import { ARCHIVE_DDL } from "@shared/archive-schema";
import { rowsForAdapter } from "../worker/archive-store";

const legacy = JSON.parse(
  readFileSync(new URL("../data/legacy-price-history.json", import.meta.url), "utf8"),
) as unknown[];

describe("legacy archive plan", () => {
  const planned = planLegacyArchive(legacy);

  it("keeps every game row and stores run summaries separately", () => {
    expect(legacy).toHaveLength(750);
    expect(planned.pulls).toHaveLength(747);
    expect(planned.summaries).toHaveLength(3);
    expect(planned.pulls.every((pull) => pull.source === "legacy-box")).toBe(true);
    expect(planned.summaries.every((summary) => summary.source === "legacy-box")).toBe(true);
    expect(planned.pulls.some((pull) => pull.gameDate == null)).toBe(false);
  });

  it("keeps the original label and numeric strings", () => {
    const row = planned.pulls.find(
      (pull) => pull.legacyLabel === "seatdata 107 Row P" && pull.gameDate === "2026-10-21",
    );
    expect(row?.getIn).toBe(30);
    expect(row?.liveAsk).toBe(120.9);
    expect(row?.etDate).toBe("2026-08-27");
    const carried = planned.pulls.find((pull) => pull.note === "carried_forward");
    expect(carried?.payload).toMatchObject({ carried_forward: true });
  });

  it("uses stable ids so a second load does not invent new rows", () => {
    const again = planLegacyArchive(legacy);
    expect(again.pulls.map((pull) => pull.externalId)).toEqual(
      planned.pulls.map((pull) => pull.externalId),
    );
    expect(new Set(planned.pulls.map((pull) => pull.externalId)).size).toBe(747);
  });
});

describe("price_history preservation", () => {
  it("copies the daily summary shape without listings", () => {
    const [pull] = planPriceHistoryArchive(
      ["game_date", "source", "et_date", "pulled_at", "median", "get_in", "listing_count", "comp_count", "excluded_dump"],
      [
        {
          game_date: "2026-10-21",
          source: "seatdata",
          et_date: "2026-09-22",
          pulled_at: "2026-09-22T17:40:00.000Z",
          median: 220.93,
          get_in: null,
          listing_count: null,
          comp_count: 174,
          excluded_dump: 0,
        },
      ],
    );
    expect(pull?.externalId).toBe("price-history:2026-10-21:seatdata:2026-09-22");
    expect(pull?.source).toBe("seatdata");
    expect(pull?.median).toBe(220.93);
    expect(pull?.compCount).toBe(174);
    expect(pull?.listings).toEqual([]);
    expect(pull?.note).toBe("preserved from price_history");
  });

  it("copies zone comps stored on the older per-run table", () => {
    const [pull] = planPriceHistoryArchive(
      ["game_date", "source", "captured_at", "median", "get_in", "market_details"],
      [
        {
          game_date: "2026-10-21",
          source: "seatdata",
          captured_at: "2026-09-22T17:40:00.000Z",
          median: 160.1,
          get_in: 25.02,
          market_details: JSON.stringify({
            zone_median: 220.93,
            zone_comp_count: 2,
            zone_comps: [
              { section: "107", row: "P", quantity: 2, price: 88.51, active: 1 },
              { section: "118", row: "N", quantity: "2", price: "92.22", active: true, listing_id: "abc" },
            ],
          }),
        },
      ],
    );
    expect(pull?.listings).toHaveLength(2);
    expect(pull?.listings[1]).toMatchObject({
      section: "118",
      row: "N",
      quantity: 2,
      price: 92.22,
      active: 1,
      extra: { listing_id: "abc" },
    });
    expect(pull?.compCount).toBe(2);
    expect(pull?.median).toBe(160.1);
  });
});

describe("book snapshots", () => {
  it("archives current and previous zone comps", () => {
    const pulls = planBookSnapshots({
      games: [
        {
          date: "2026-10-21",
          opponent: "Milwaukee Bucks",
          market_updated_at_et: "2026-09-22 1:40pm",
          market_details: {
            source: "seatdata",
            asof: "2026-09-22 1:40pm",
            zone_median: 220.93,
            zone_get_in: 87.13,
            zone_comp_count: 1,
            zone_comps: [{ section: "107", row: "P", quantity: 2, price: 87.13 }],
          },
          market_previous_details: {
            asof: "2026-09-15 12:51pm",
            zone_comps: [{ section: "118", row: "N", quantity: 2, price: 92.22 }],
          },
        },
      ],
    });
    expect(pulls).toHaveLength(2);
    expect(pulls[0]?.source).toBe("book-snapshot");
    expect(pulls[0]?.pulledAt).toBe("2026-09-22T17:40:00.000Z");
    expect(pulls[0]?.etDate).toBe("2026-09-22");
    expect(pulls[0]?.listings[0]?.price).toBe(87.13);
    expect(pulls[1]?.legacyLabel).toBe("market_previous_details");
    expect(pulls[1]?.etDate).toBe("2026-09-15");
  });
});

describe("observed pulls", () => {
  it("keeps every listing and does not collapse two runs", () => {
    const now = new Date("2026-10-07T16:00:00.000Z");
    const pulls = planObservedPulls({
      source: "seatdata",
      trigger: "cron",
      now,
      ids: ["one", "two"],
      rows: [
        {
          gameDate: "2026-10-21",
          status: "ok",
          paid: true,
          listings: [
            { section: "107", row: "P", quantity: 2, price: 80, active: 1 },
            { section: "100", row: "A", quantity: 1, price: 10, active: 0 },
          ],
          median: 80,
          compCount: 1,
        },
        {
          gameDate: null,
          status: "failed",
          error: "http_401",
          httpStatus: 401,
        },
      ],
    });
    expect(pulls[0]?.listings).toHaveLength(2);
    expect(pulls[0]?.etDate).toBe("2026-10-07");
    expect(pulls[1]?.status).toBe("failed");
    expect(pulls[1]?.externalId).toBe("two");
  });

  it("logs a gated source once and prefers explicit observations", () => {
    expect(
      rowsForAdapter({
        aborted: "missing_credential",
        paid: false,
        points: [],
        observations: [],
      })[0],
    ).toMatchObject({ status: "skipped", error: "missing_credential" });
    expect(
      rowsForAdapter({
        aborted: "http_500",
        paid: true,
        points: [],
        observations: [{ gameDate: "2026-10-21", status: "failed", error: "http_500" }],
      }),
    ).toHaveLength(1);
  });
});

describe("export", () => {
  it("rejects a bad date and builds a parameterized filter", () => {
    expect(parseExportQuery(new URLSearchParams("from=09-22"))).toEqual({
      error: "from must be YYYY-MM-DD",
    });
    const query = parseExportQuery(
      new URLSearchParams("format=csv&table=listings&game=2026-10-21&from=2026-08-26&source=legacy-box"),
    );
    expect(query).toMatchObject({ format: "csv", table: "listings", game: "2026-10-21" });
    if ("error" in query) throw new Error(query.error);
    expect(pullFilter(query, "p")).toEqual({
      sql: "WHERE p.game_date = ? AND p.source = ? AND p.et_date >= ?",
      binds: ["2026-10-21", "legacy-box", "2026-08-26"],
    });
  });

  it("escapes commas and spreadsheet formulas", () => {
    const csv = toCsv(LISTING_CSV_COLUMNS, [
      { pull_id: 1, section: "107", row: "P,Q", price: 10, opponent: "=cmd" },
    ]);
    expect(csv.split("\n")[0]).toBe(LISTING_CSV_COLUMNS.join(","));
    expect(csv).toContain('"P,Q"');
    expect(csv).toContain("'=cmd");
  });
});

describe("archive ddl", () => {
  it("matches the migration and never deletes", () => {
    const migration = readFileSync(
      new URL("../migrations/0003_price_archive.sql", import.meta.url),
      "utf8",
    );
    expect(ARCHIVE_DDL.trim()).toBe(migration.trim());
    expect(migration.toLowerCase()).not.toContain("delete ");
    expect(migration.toLowerCase()).not.toContain("drop ");
    const writer = readFileSync(new URL("../worker/archive-store.ts", import.meta.url), "utf8");
    expect(writer).toContain("ON CONFLICT(external_id) DO NOTHING");
    expect(writer.toLowerCase()).not.toMatch(/delete\s+from\s+price_/);
    const inserts = writer.slice(writer.indexOf("const INSERT_PULL"), writer.indexOf("export function rowsForAdapter"));
    expect(inserts).toContain("DO NOTHING");
    expect(inserts).not.toContain("DO UPDATE");
  });
});

describe("et stamps", () => {
  it("reads a September afternoon as Eastern Daylight Time", () => {
    expect(etStampToIso("2026-09-22 1:40pm")).toBe("2026-09-22T17:40:00.000Z");
    expect(etStampToIso("2026-12-18 7:00pm")).toBe("2026-12-19T00:00:00.000Z");
  });
});

describe("listings", () => {
  it("reads a listings array or a body that wraps one", () => {
    expect(listingsFromUnknown([{ section: "107", row: "P", price: 1 }])).toHaveLength(1);
    expect(listingsFromUnknown({ listings: [{ price: 2 }] })).toHaveLength(1);
    expect(listingsFromUnknown(null)).toEqual([]);
  });
});
