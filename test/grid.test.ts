import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pairFromTypeIn } from "@shared/book";
import {
  buildPriceGrid,
  firstSuggestedWins,
  formatEtExact,
  gridToCsv,
  parseGridMetrics,
  planRecomputedAsks,
  planSnapshotAsks,
  pointCaption,
  recoverPullMetrics,
  suggestedExternalId,
  type GridPull,
  type SuggestedAskDraft,
} from "@shared/grid";
import { askOffers } from "@shared/price-model";
import { daysUntil } from "@shared/pricing";
import type { TrendListing, TrendPull, TrendsGameSeed } from "@shared/trends";
import { fillPullsFromArchive, gridResponse } from "../worker/grid";

function seed(partial: Partial<TrendsGameSeed> & Pick<TrendsGameSeed, "date" | "opponent">): TrendsGameSeed {
  return {
    weekday: "Wed",
    timeEt: "7:00 PM",
    type: "regular",
    demand: null,
    bookMedian: null,
    ...partial,
  };
}

function pull(partial: Partial<TrendPull> & Pick<TrendPull, "id" | "source" | "gameDate" | "etDate">): TrendPull {
  return {
    pulledAt: `${partial.etDate}T16:00:00.000Z`,
    opponent: "Milwaukee Bucks",
    median: 100,
    getIn: null,
    liveAsk: null,
    legacyLabel: null,
    payload: null,
    ...partial,
  };
}

function gridPull(partial: Partial<GridPull> & Pick<GridPull, "id" | "source" | "gameDate" | "etDate">): GridPull {
  return {
    pulledAt: `${partial.etDate}T16:00:00.000Z`,
    opponent: "Milwaukee Bucks",
    median: null,
    getIn: null,
    estAsk: null,
    liveAsk: null,
    listingCount: null,
    compCount: null,
    legacyLabel: null,
    payload: null,
    rawKey: null,
    ...partial,
  };
}

describe("suggested ask snapshots", () => {
  const game = seed({ date: "2026-10-21", opponent: "Milwaukee Bucks" });
  const recordedAt = "2026-10-16T16:00:00.000Z";

  it("saves today's model ask once and does not replace it", () => {
    const pulls = [
      pull({ id: 1, source: "seatdata", gameDate: game.date, etDate: "2026-10-01", median: 180, compCount: 8 }),
      pull({ id: 2, source: "seatdata", gameDate: game.date, etDate: "2026-10-08", median: 190, compCount: 8 }),
      pull({ id: 3, source: "seatdata", gameDate: game.date, etDate: "2026-10-16", median: 200, compCount: 8 }),
    ];
    const first = planSnapshotAsks({
      asOf: "2026-10-16",
      recordedAt,
      games: [game],
      pulls,
      listings: [],
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      externalId: suggestedExternalId(game.date, "2026-10-16"),
      origin: "snapshot",
      source: "model",
      gameDate: game.date,
      etDate: "2026-10-16",
    });
    expect(first[0]?.ask).toBeGreaterThan(0);

    const later = planSnapshotAsks({
      asOf: "2026-10-16",
      recordedAt: "2026-10-16T20:00:00.000Z",
      games: [game],
      pulls: pulls.map((row) => (row.id === 3 ? { ...row, median: 400 } : row)),
      listings: [],
    });
    expect(later[0]?.ask).not.toBe(first[0]?.ask);
    const kept = firstSuggestedWins(first, later);
    expect(kept).toEqual(first);
  });

  it("recomputes past days from that day's comps and ignores later pulls", () => {
    const games = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22"].map((date, index) =>
      seed({ date, opponent: ["Boston Celtics", "Detroit Pistons", "Charlotte Hornets", "Milwaukee Bucks"][index] ?? "Home" }),
    );
    const days = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"];
    const history: TrendPull[] = [];
    let id = 1;
    for (const [gameIndex, game] of games.entries()) {
      for (const [dayIndex, etDate] of days.entries()) {
        history.push(
          pull({
            id,
            source: "seatdata",
            gameDate: game.date,
            opponent: game.opponent,
            etDate,
            median: 120 + gameIndex * 18 + dayIndex * 5,
            compCount: 8,
          }),
        );
        id += 1;
      }
    }
    const future = pull({
      id,
      source: "seatdata",
      gameDate: games[0]!.date,
      opponent: games[0]!.opponent,
      etDate: "2026-10-13",
      median: 2400,
      compCount: 12,
    });
    const input = {
      asOf: "2026-10-14",
      today: "2026-10-14",
      recordedAt,
      games,
      listings: [] as TrendListing[],
    };
    const withFuture = planRecomputedAsks({ ...input, pulls: [...history, future] });
    const without = planRecomputedAsks({ ...input, pulls: history });
    const on = (rows: SuggestedAskDraft[], gameDate: string, etDate: string) =>
      rows.find((row) => row.gameDate === gameDate && row.etDate === etDate);

    const leaked = on(withFuture, games[0]!.date, "2026-10-06");
    const clean = on(without, games[0]!.date, "2026-10-06");
    expect(leaked?.origin).toBe("recomputed");
    expect(leaked?.method).toBe("model");
    expect(leaked).toEqual(clean);

    const jumped = on(withFuture, games[0]!.date, "2026-10-13");
    expect(jumped?.origin).toBe("recomputed");
    expect(jumped?.source).toBe("seatdata");
    expect(jumped?.ask).not.toBe(leaked?.ask);

    const quiet = planRecomputedAsks({
      ...input,
      today: "2026-10-02",
      pulls: [
        pull({
          id: 1,
          source: "apify",
          gameDate: games[0]!.date,
          etDate: "2026-10-01",
          median: 40,
          getIn: 12,
        }),
      ],
    });
    expect(quiet).toEqual([]);
  });

  it("uses the list model on a single comp day, marked recomputed", () => {
    const game = seed({ date: "2026-11-20", opponent: "Boston Celtics", demand: "bigger" });
    const rows = planRecomputedAsks({
      asOf: "2026-10-16",
      today: "2026-10-16",
      recordedAt,
      games: [game],
      pulls: [pull({ id: 1, source: "seatdata", gameDate: game.date, etDate: "2026-10-01", median: 150, compCount: 6 })],
      listings: [],
    });
    const daysOut = daysUntil(game.date, "2026-10-01");
    const offers = askOffers({ predictedMedian: 150, daysOut: daysOut ?? 0, supply: 6 });
    expect(rows[0]).toMatchObject({
      origin: "recomputed",
      method: "model",
      source: "seatdata",
      etDate: "2026-10-01",
    });
    expect(offers.map((offer) => offer.ask)).toContain(rows[0]?.ask);
  });
});

describe("price grid", () => {
  const now = new Date("2026-10-16T18:00:00.000Z");
  const game = seed({ date: "2026-10-21", opponent: "Milwaukee Bucks", weekday: "Wed" });

  it("stacks stored metrics, newest day first, and leaves a gap day out of the cell", () => {
    const listings: TrendListing[] = [
      { pullId: 2, section: "107", row: "P", quantity: 2, price: 50, active: 1 },
      { pullId: 2, section: "118", row: "N", quantity: 2, price: 100, active: 1 },
      { pullId: 2, section: "119", row: "J", quantity: 2, price: 140, active: 1 },
      { pullId: 2, section: "400", row: "1", quantity: 2, price: 9, active: 1 },
    ];
    const grid = buildPriceGrid({
      now,
      today: "2026-10-16",
      games: [game, seed({ date: "2026-11-02", opponent: "Detroit Pistons" })],
      pulls: [
        gridPull({
          id: 1,
          source: "legacy-box",
          gameDate: game.date,
          etDate: "2026-08-26",
          pulledAt: "2026-08-26T04:06:45.000Z",
          opponent: game.opponent,
          getIn: 33,
          estAsk: 92,
          legacyLabel: "seatdata_jt_median",
          payload: { going_price: 180, ask_per_ticket: 180, get_in: 33 },
        }),
        gridPull({
          id: 2,
          source: "seatdata",
          gameDate: game.date,
          etDate: "2026-10-16",
          pulledAt: "2026-10-16T12:12:00.000Z",
          median: 999,
          getIn: 80,
          compCount: 2,
          listingCount: 4,
        }),
        gridPull({
          id: 3,
          source: "apify",
          gameDate: game.date,
          etDate: "2026-10-16",
          pulledAt: "2026-10-16T13:00:00.000Z",
          median: 70,
          getIn: 15,
        }),
      ],
      listings,
      suggested: [
        {
          externalId: suggestedExternalId(game.date, "2026-08-26"),
          gameDate: game.date,
          etDate: "2026-08-26",
          recordedAt: now.toISOString(),
          ask: 175,
          origin: "recomputed",
          source: "legacy-box",
          pulledAt: "2026-08-26T04:06:45.000Z",
          method: "model",
        },
      ],
    });

    expect(grid.days).toEqual(["2026-10-16", "2026-08-26"]);
    const bucks = grid.games.find((row) => row.date === game.date);
    expect(bucks?.cells["2026-09-01"]).toBeUndefined();
    expect(bucks?.cells["2026-08-26"]?.suggested).toMatchObject({ value: 175, origin: "recomputed" });
    expect(bucks?.cells["2026-08-26"]?.comps?.value).toBe(180);
    expect(bucks?.cells["2026-08-26"]?.get_in?.value).toBe(33);
    expect(bucks?.cells["2026-08-26"]?.est_ask?.value).toBe(92);
    expect(bucks?.cells["2026-08-26"]?.median).toBeUndefined();
    expect(pointCaption(bucks!.cells["2026-08-26"]!.suggested!)).toContain("ET");
    expect(pointCaption(bucks!.cells["2026-08-26"]!.suggested!)).toContain("recomputed");
    expect(pointCaption(bucks!.cells["2026-08-26"]!.get_in!)).toContain("SeatData");

    const today = bucks?.cells["2026-10-16"];
    expect(today?.high?.value).toBe(140);
    expect(today?.comps?.value).toBe(120);
    expect(today?.median?.value).toBe(70);
    expect(today?.median?.source).toBe("apify");
    expect(today?.get_in?.value).toBe(15);
    expect(formatEtExact("2026-08-26T04:06:45.000Z")).toMatch(/12:06:45 AM ET/);

    const onlyGetIn = buildPriceGrid({
      now,
      today: "2026-10-16",
      games: [game],
      pulls: grid.games.length
        ? [
            gridPull({
              id: 1,
              source: "seatdata",
              gameDate: game.date,
              etDate: "2026-10-16",
              median: 120,
              getIn: 40,
            }),
          ]
        : [],
      listings: [],
      suggested: [],
      metrics: parseGridMetrics("get_in,nope"),
      team: "bucks",
    });
    expect(onlyGetIn.metrics.map((metric) => metric.id)).toEqual(["get_in"]);
    expect(onlyGetIn.games).toHaveLength(1);
    expect(onlyGetIn.games[0]?.cells["2026-10-16"]?.get_in?.value).toBe(40);
    expect(onlyGetIn.games[0]?.cells["2026-10-16"]?.median).toBeUndefined();

    const csv = gridToCsv(
      buildPriceGrid({
        now,
        today: "2026-10-16",
        games: [game],
        pulls: [
          gridPull({
            id: 9,
            source: "seatdata",
            gameDate: game.date,
            etDate: "2026-10-16",
            median: 100,
          }),
        ],
        listings: [],
        suggested: [],
        metrics: ["median"],
      }),
      { keep: true },
    );
    expect(csv).toContain("Median");
    expect(csv).toContain(String(pairFromTypeIn(100)));
    expect(csv.split("\n")[0]).toBe("game_date,opponent,day,metric,per_seat,keep,pulled_at,source,origin");
  });

  it("reads a raw archive body when the pull row itself has no prices", () => {
    const recovered = recoverPullMetrics({
      listings: [
        { section: "118", row: "N", quantity: 2, price: 110, active: true },
        { section: "119", row: "K", quantity: 2, price: 150, active: true },
      ],
      get_in: 25,
    });
    expect(recovered?.getIn).toBe(25);
    expect(recovered?.listings).toHaveLength(2);
    const grid = buildPriceGrid({
      now,
      today: "2026-10-16",
      games: [game],
      pulls: [
        gridPull({
          id: 4,
          source: "seatdata",
          gameDate: game.date,
          etDate: "2026-10-15",
          getIn: recovered?.getIn ?? null,
          rawKey: "raw/2026-10-15/seatdata/pull.json.gz",
        }),
      ],
      listings: (recovered?.listings ?? []).map((listing) => ({ pullId: 4, ...listing })),
      suggested: [],
      metrics: ["high", "comps", "get_in"],
    });
    expect(grid.games[0]?.cells["2026-10-15"]?.high?.value).toBe(150);
    expect(grid.games[0]?.cells["2026-10-15"]?.comps?.value).toBe(130);
    expect(grid.games[0]?.cells["2026-10-15"]?.get_in?.value).toBe(25);
  });
});

describe("R2 archive fallback", () => {
  it("reads a gzipped raw body when the D1 row has no prices", async () => {
    const body = JSON.stringify({
      get_in: 22,
      listings: [
        { section: "118", row: "N", quantity: 2, price: 100, active: true },
        { section: "119", row: "J", quantity: 2, price: 160, active: true },
      ],
    });
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = await new Response(stream).arrayBuffer();
    const pulls = [
      gridPull({
        id: 8,
        source: "seatdata",
        gameDate: "2026-10-21",
        etDate: "2026-10-14",
        rawKey: "raw/2026-10-14/seatdata/x.json.gz",
      }),
    ];
    const listings: TrendListing[] = [];
    await fillPullsFromArchive(
      {
        ARCHIVE: {
          async get(key: string) {
            expect(key).toBe("raw/2026-10-14/seatdata/x.json.gz");
            return { arrayBuffer: async () => bytes };
          },
        },
      } as unknown as Env,
      pulls,
      listings,
    );
    expect(pulls[0]?.getIn).toBe(22);
    expect(listings.map((row) => row.price)).toEqual([100, 160]);
  });
});

describe("GET /api/grid", () => {
  it("returns the same JSON, keeps the first snapshot, and does not require a bearer token", async () => {
    const db = new DatabaseSync(":memory:");
    for (const name of [
      "0001_init.sql",
      "0002_price_history.sql",
      "0003_price_archive.sql",
      "0004_price_model.sql",
      "0005_likely_sales.sql",
      "0006_instant_offers.sql",
      "0007_suggested_asks.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    const env = fakeEnv(db);
    const now = new Date("2026-10-16T16:00:00.000Z");
    db.prepare(
      `INSERT INTO price_pulls (
         external_id, pulled_at, et_date, trigger_name, source, game_date, opponent, status,
         paid, excluded_dump, median, get_in, comp_count
       ) VALUES (?, ?, ?, 'http', 'seatdata', ?, ?, 'ok', 0, 0, ?, ?, ?)`,
    ).run(
      "test-pull-1",
      "2026-10-15T15:00:00.000Z",
      "2026-10-15",
      "2026-10-21",
      "Milwaukee Bucks",
      188,
      90,
      6,
    );

    const response = await gridResponse(env, new Request("https://book.example/api/grid?metrics=suggested,get_in&team=bucks"), now);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      days: string[];
      metrics: { id: string }[];
      games: { date: string; opponent: string; cells: Record<string, { suggested?: { value: number; origin: string }; get_in?: { value: number; source: string } }> }[];
    };
    expect(body.metrics.map((metric) => metric.id)).toEqual(["suggested", "get_in"]);
    expect(body.games.every((game) => game.opponent.toLowerCase().includes("buck"))).toBe(true);
    const bucks = body.games.find((game) => game.date === "2026-10-21");
    expect(bucks?.cells["2026-10-15"]?.get_in).toMatchObject({ value: 90, source: "seatdata" });
    expect(bucks?.cells["2026-08-26"]?.get_in?.value).toBe(33);
    const suggested = bucks?.cells["2026-10-15"]?.suggested;
    expect(suggested?.origin === "recomputed" || suggested?.origin === "snapshot").toBe(true);

    const saved = db
      .prepare(`SELECT external_id, ask, origin FROM suggested_asks WHERE game_date = ? AND et_date = ?`)
      .get("2026-10-21", "2026-10-15") as { external_id: string; ask: number; origin: string };
    expect(saved.origin).toBe("recomputed");
    db.prepare(`UPDATE suggested_asks SET ask = 12345 WHERE external_id = ?`).run(saved.external_id);

    const again = await gridResponse(env, new Request("https://book.example/api/grid?metrics=suggested&team=bucks"), now);
    const next = (await again.json()) as {
      games: { date: string; cells: Record<string, { suggested?: { value: number } }> }[];
    };
    expect(next.games.find((game) => game.date === "2026-10-21")?.cells["2026-10-15"]?.suggested?.value).toBe(12345);

    const denied = await gridResponse(env, new Request("https://book.example/api/grid", { method: "POST" }), now);
    expect(denied.status).toBe(405);

    const index = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    const gridAt = index.indexOf('"/api/grid"');
    const exportAt = index.indexOf('"/api/export"');
    expect(gridAt).toBeGreaterThan(0);
    expect(exportAt).toBeGreaterThan(gridAt);
    expect(index.slice(gridAt, exportAt)).toContain("gridResponse");
    expect(index.slice(gridAt, exportAt)).not.toContain("authorizeBearer");
  }, 120_000);
});

function fakeEnv(db: DatabaseSync): Env {
  function exec(sql: string, params: unknown[], mode: "run" | "all" | "first") {
    const statement = db.prepare(sql);
    const bound = params.map((value) => (value === undefined ? null : value));
    if (mode === "first") return statement.get(...(bound as never[])) ?? null;
    if (mode === "all" || /returning/i.test(sql)) {
      return { results: statement.all(...(bound as never[])), meta: {} };
    }
    const info = statement.run(...(bound as never[]));
    return { results: [], meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }

  function prepare(sql: string) {
    const statement = (params: unknown[]) => ({
      sql,
      params,
      run: () => Promise.resolve(exec(sql, params, "run")),
      all: () => Promise.resolve(exec(sql, params, "all")),
      first: () => Promise.resolve(exec(sql, params, "first")),
    });
    return { ...statement([]), bind: (...params: unknown[]) => statement(params) };
  }

  return {
    DB: {
      prepare,
      async batch(statements: { sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }[]) {
        const results = [];
        for (const statement of statements) {
          results.push(/returning/i.test(statement.sql) ? await statement.all() : await statement.run());
        }
        return results;
      },
    },
  } as unknown as Env;
}
