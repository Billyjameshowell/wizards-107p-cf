import { describe, expect, it } from "vitest";
import type { Game, ListingOverride } from "@shared/book";
import {
  sortGameRows,
  timeToMinutes,
  toggleSort,
  type SortableGameRow,
} from "@/lib/sort-games";

function row(
  partial: Partial<Game> & Pick<Game, "date" | "opponent">,
  status?: Partial<ListingOverride>,
): SortableGameRow {
  return {
    game: {
      weekday: "Sat",
      time_et: "7:00 PM",
      type: "regular",
      sit_or_sell: "Sit",
      advised_ask: null,
      cash_both_after_fee: null,
      listed: false,
      listed_ask: null,
      sold: false,
      notes: "",
      ticketdata_url: null,
      ...partial,
    },
    status: {
      listed: status?.listed ?? false,
      sold: status?.sold ?? false,
      notes: status?.notes ?? "",
    },
  };
}

describe("toggleSort", () => {
  it("starts a new column ascending and flips the same column", () => {
    const dateAsc = { key: "date" as const, direction: "asc" as const };
    const ask = toggleSort(dateAsc, "advised_ask");
    expect(ask).toEqual({ key: "advised_ask", direction: "asc" });
    expect(toggleSort(ask, "advised_ask")).toEqual({ key: "advised_ask", direction: "desc" });
    expect(toggleSort({ key: "advised_ask", direction: "desc" }, "advised_ask").direction).toBe("asc");
  });
});

describe("sortGameRows", () => {
  it("sorts dates chronologically and money numerically", () => {
    const rows = [
      row({ date: "2026-12-01", opponent: "Bucks", advised_ask: 20, cash_both_after_fee: 36 }),
      row({ date: "2026-02-03", opponent: "Nets", advised_ask: 100, cash_both_after_fee: 180 }),
      row({ date: "2026-10-10", opponent: "Hornets", advised_ask: 9, cash_both_after_fee: 16.2 }),
    ];

    expect(sortGameRows(rows, { key: "date", direction: "asc" }).map((item) => item.game.date)).toEqual([
      "2026-02-03",
      "2026-10-10",
      "2026-12-01",
    ]);
    expect(sortGameRows(rows, { key: "date", direction: "desc" }).map((item) => item.game.date)).toEqual([
      "2026-12-01",
      "2026-10-10",
      "2026-02-03",
    ]);
    expect(sortGameRows(rows, { key: "advised_ask", direction: "asc" }).map((item) => item.game.advised_ask)).toEqual([
      9, 20, 100,
    ]);
    expect(
      sortGameRows(rows, { key: "cash", direction: "desc" }).map((item) => item.game.cash_both_after_fee),
    ).toEqual([180, 36, 16.2]);
  });

  it("sorts get-in and median numerically, using mean only when median is missing", () => {
    const rows = [
      row({ date: "2026-11-01", opponent: "A", market_get_in: 100, market_median: 50, market_mean: 10 }),
      row({ date: "2026-11-02", opponent: "B", market_get_in: 20, market_mean: 80 }),
      row({ date: "2026-11-03", opponent: "C", market_get_in: null, market_median: 15 }),
    ];
    expect(sortGameRows(rows, { key: "get_in", direction: "asc" }).map((item) => item.game.opponent)).toEqual([
      "B",
      "A",
      "C",
    ]);
    expect(sortGameRows(rows, { key: "central", direction: "asc" }).map((item) => item.game.opponent)).toEqual([
      "C",
      "A",
      "B",
    ]);
    expect(sortGameRows(rows, { key: "central", direction: "desc" }).map((item) => item.game.opponent)).toEqual([
      "B",
      "A",
      "C",
    ]);
  });

  it("keeps blank prices last in both directions", () => {
    const rows = [
      row({ date: "2026-10-01", opponent: "A", advised_ask: null }),
      row({ date: "2026-10-02", opponent: "B", advised_ask: 50 }),
      row({ date: "2026-10-03", opponent: "C", advised_ask: 10 }),
    ];
    expect(sortGameRows(rows, { key: "advised_ask", direction: "asc" }).map((item) => item.game.opponent)).toEqual([
      "C",
      "B",
      "A",
    ]);
    expect(sortGameRows(rows, { key: "advised_ask", direction: "desc" }).map((item) => item.game.opponent)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  it("sorts type, opponent, sit/sell, clock time, flags, and notes", () => {
    const rows = [
      row(
        {
          date: "2026-10-30",
          opponent: "Philadelphia 76ers",
          type: "regular",
          time_et: "7:00 PM",
          sit_or_sell: "Sit",
          ticketdata_url: "https://example.com/b",
        },
        { listed: true, sold: false, notes: "Opening night" },
      ),
      row(
        {
          date: "2026-10-10",
          opponent: "Detroit Pistons",
          type: "preseason",
          time_et: "1:00 PM",
          sit_or_sell: "Sell",
          ticketdata_url: null,
        },
        { listed: false, sold: true, notes: "" },
      ),
      row(
        {
          date: "2026-10-12",
          opponent: "Brooklyn Nets",
          type: "preseason",
          time_et: "12:30 PM",
          sit_or_sell: "TBD",
          ticketdata_url: "https://example.com/a",
        },
        { listed: false, sold: false, notes: "Afternoon" },
      ),
    ];

    expect(sortGameRows(rows, { key: "type", direction: "asc" }).map((item) => item.game.opponent)).toEqual([
      "Detroit Pistons",
      "Brooklyn Nets",
      "Philadelphia 76ers",
    ]);
    expect(sortGameRows(rows, { key: "opponent", direction: "asc" }).map((item) => item.game.opponent)).toEqual([
      "Brooklyn Nets",
      "Detroit Pistons",
      "Philadelphia 76ers",
    ]);
    expect(sortGameRows(rows, { key: "sit_or_sell", direction: "asc" }).map((item) => item.game.sit_or_sell)).toEqual([
      "Sell",
      "Sit",
      "TBD",
    ]);
    expect(sortGameRows(rows, { key: "time", direction: "asc" }).map((item) => item.game.time_et)).toEqual([
      "12:30 PM",
      "1:00 PM",
      "7:00 PM",
    ]);
    expect(sortGameRows(rows, { key: "listed", direction: "desc" }).map((item) => item.status.listed)).toEqual([
      true,
      false,
      false,
    ]);
    expect(sortGameRows(rows, { key: "sold", direction: "asc" }).map((item) => item.status.sold)).toEqual([
      false,
      false,
      true,
    ]);
    expect(sortGameRows(rows, { key: "notes", direction: "asc" }).map((item) => item.status.notes)).toEqual([
      "Afternoon",
      "Opening night",
      "",
    ]);
    expect(sortGameRows(rows, { key: "ticketdata", direction: "asc" }).map((item) => item.game.ticketdata_url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      null,
    ]);
  });
});

describe("timeToMinutes", () => {
  it("parses 12-hour clock times", () => {
    expect(timeToMinutes("12:00 AM")).toBe(0);
    expect(timeToMinutes("12:30 PM")).toBe(12 * 60 + 30);
    expect(timeToMinutes("1:00 PM")).toBe(13 * 60);
    expect(timeToMinutes("7:00 PM")).toBe(19 * 60);
    expect(timeToMinutes("tipoff")).toBeNull();
  });
});
