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
  slicePriceGrid,
  suggestedExternalId,
  type GridPull,
  type PriceGrid,
  type SuggestedAskDraft,
} from "@shared/grid";
import { askOffers } from "@shared/price-model";
import { daysUntil } from "@shared/pricing";
import type { TrendListing, TrendPull, TrendsGameSeed } from "@shared/trends";
import { fillPullsFromArchive, GRID_CACHE_KEY, GRID_LISTING_SQL, GRID_PULL_SQL, gridResponse, refreshPriceGrid } from "../worker/grid";
import { persistSuggestedAsks } from "../worker/suggested-asks";

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
    expect(leaked?.method).toBe("day-rules");
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
      method: "day-rules",
      source: "seatdata",
      etDate: "2026-10-01",
    });
    void offers; // median rule now wins over the list model, matching the book
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

describe("slicePriceGrid", () => {
  const grid: PriceGrid = {
    asof: "2026-10-16T16:00:00.000Z",
    today: "2026-10-16",
    metrics: [
      { id: "suggested", label: "Suggested price", kind: "price" },
      { id: "median", label: "Median", kind: "price" },
      { id: "get_in", label: "Get-in", kind: "price" },
    ],
    days: ["2026-10-16", "2026-10-15"],
    games: [
      {
        date: "2026-10-21",
        opponent: "Milwaukee Bucks",
        weekday: "Wed",
        cells: {
          "2026-10-15": {
            suggested: point(),
            get_in: point(),
          },
        },
      },
      {
        date: "2026-10-22",
        opponent: "Detroit Pistons",
        weekday: "Thu",
        cells: { "2026-10-16": { median: point() } },
      },
    ],
  };

  it("returns the same object when nothing is filtered", () => {
    expect(slicePriceGrid(grid)).toBe(grid);
    expect(slicePriceGrid(grid, { metrics: null, team: "  " })).toBe(grid);
  });

  it("keeps the asked-for metrics and the matching teams", () => {
    const sliced = slicePriceGrid(grid, { metrics: ["get_in", "suggested"], team: "bucks" });
    expect(sliced.metrics.map((metric) => metric.id)).toEqual(["suggested", "get_in"]);
    expect(sliced.games.map((game) => game.opponent)).toEqual(["Milwaukee Bucks"]);
    expect(sliced.days).toEqual(["2026-10-15"]);
    expect(sliced.games[0]?.cells["2026-10-15"]?.suggested?.value).toBe(10);
    expect(sliced.games[0]?.cells["2026-10-15"]?.get_in?.value).toBe(10);
    expect(sliced.games[0]?.cells["2026-10-15"]?.median).toBeUndefined();
  });
});

describe("GET /api/grid", () => {
  it("serves the cached JSON, slices filters, and does not recompute", async () => {
    const db = new DatabaseSync(":memory:");
    for (const name of [
      "0001_init.sql",
      "0002_price_history.sql",
      "0003_price_archive.sql",
      "0004_price_model.sql",
      "0005_likely_sales.sql",
      "0006_instant_offers.sql",
      "0007_suggested_asks.sql",
      "0008_grid_read.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    const book = memoryBook();
    const env = fakeEnv(db, book);
    const cachedRead = fakeEnv(db, book, { dbThrows: true });
    const now = new Date("2026-10-16T16:00:00.000Z");
    db.prepare(
      `INSERT INTO price_pulls (
         external_id, pulled_at, et_date, trigger_name, source, game_date, opponent, status,
         paid, excluded_dump, median, get_in, comp_count, payload_json
       ) VALUES (?, ?, ?, 'http', 'seatdata', ?, ?, 'ok', 0, 0, ?, ?, ?, ?)`,
    ).run(
      "test-pull-1",
      "2026-10-15T15:00:00.000Z",
      "2026-10-15",
      "2026-10-21",
      "Milwaukee Bucks",
      188,
      null,
      6,
      JSON.stringify({ get_in: 33, going_price: 180 }),
    );

    const missing = await gridResponse(cachedRead, new Request("https://book.example/api/grid"));
    expect(missing.status).toBe(503);

    await refreshPriceGrid(env, now);
    const asksAfterRefresh = db.prepare(`SELECT COUNT(*) AS n FROM suggested_asks`).get() as { n: number };
    expect(asksAfterRefresh.n).toBe(0);

    const cached = await gridResponse(cachedRead, new Request("https://book.example/api/grid"));
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(book.values.get(GRID_CACHE_KEY));

    const response = await gridResponse(
      cachedRead,
      new Request("https://book.example/api/grid?metrics=suggested,get_in,comps&team=bucks"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PriceGrid;
    expect(body.metrics.map((metric) => metric.id)).toEqual(["suggested", "get_in", "comps"]);
    expect(body.games.every((game) => game.opponent.toLowerCase().includes("buck"))).toBe(true);
    const bucks = body.games.find((game) => game.date === "2026-10-21");
    expect(bucks?.cells["2026-10-15"]?.get_in).toMatchObject({ value: 33, source: "seatdata" });
    expect(bucks?.cells["2026-10-15"]?.comps).toMatchObject({ value: 180, source: "seatdata" });
    expect(bucks?.cells["2026-10-15"]?.suggested).toBeUndefined();

    db.prepare(`UPDATE price_pulls SET get_in = 12345 WHERE external_id = ?`).run("test-pull-1");
    const stale = await gridResponse(cachedRead, new Request("https://book.example/api/grid?metrics=get_in&team=bucks"));
    const staleBody = (await stale.json()) as PriceGrid;
    expect(staleBody.games.find((game) => game.date === "2026-10-21")?.cells["2026-10-15"]?.get_in?.value).toBe(33);

    await refreshPriceGrid(env, now);
    const fresh = await gridResponse(cachedRead, new Request("https://book.example/api/grid?metrics=get_in&team=bucks"));
    const freshBody = (await fresh.json()) as PriceGrid;
    expect(freshBody.games.find((game) => game.date === "2026-10-21")?.cells["2026-10-15"]?.get_in?.value).toBe(12345);

    const denied = await gridResponse(cachedRead, new Request("https://book.example/api/grid", { method: "POST" }));
    expect(denied.status).toBe(405);
  });

  it("writes suggested asks and the cache from the cron path only", async () => {
    const db = new DatabaseSync(":memory:");
    for (const name of [
      "0001_init.sql",
      "0002_price_history.sql",
      "0003_price_archive.sql",
      "0004_price_model.sql",
      "0005_likely_sales.sql",
      "0006_instant_offers.sql",
      "0007_suggested_asks.sql",
      "0008_grid_read.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    db.prepare(
      `INSERT INTO price_pulls (
         external_id, pulled_at, et_date, trigger_name, source, game_date, opponent, status,
         paid, excluded_dump, median, get_in, comp_count
       ) VALUES (?, ?, ?, 'cron', 'seatdata', ?, ?, 'ok', 0, 0, 188, 90, 6)`,
    ).run("cron-pull", "2026-10-15T15:00:00.000Z", "2026-10-15", "2026-10-21", "Milwaukee Bucks");
    const book = memoryBook();
    const env = fakeEnv(db, book);
    const now = new Date("2026-10-16T16:00:00.000Z");

    await persistSuggestedAsks(env, now, { fillToday: true });
    const saved = db
      .prepare(`SELECT external_id, ask, origin FROM suggested_asks WHERE game_date = ? AND et_date = ?`)
      .get("2026-10-21", "2026-10-15") as { external_id: string; ask: number; origin: string };
    expect(saved.origin).toBe("recomputed");
    expect(saved.ask).toBeGreaterThan(0);

    await persistSuggestedAsks(env, now, { fillToday: true });
    const again = db.prepare(`SELECT ask FROM suggested_asks WHERE external_id = ?`).get(saved.external_id) as { ask: number };
    expect(again.ask).toBe(saved.ask);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM suggested_asks WHERE external_id = ?`).get(saved.external_id) as { n: number }).n).toBe(1);

    // The grid is its own cron step after the refit.
    await refreshPriceGrid(env, now);
    const response = await gridResponse(env, new Request("https://book.example/api/grid?metrics=suggested&team=bucks"));
    const body = (await response.json()) as PriceGrid;
    expect(body.games.find((game) => game.date === "2026-10-21")?.cells["2026-10-15"]?.suggested).toMatchObject({
      value: saved.ask,
      origin: "recomputed",
    });

    const asks = readFileSync(new URL("../worker/suggested-asks.ts", import.meta.url), "utf8");
    const fit = readFileSync(new URL("../worker/model-fit.ts", import.meta.url), "utf8");
    const schedule = readFileSync(new URL("../worker/schedule.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    const grid = readFileSync(new URL("../worker/grid.ts", import.meta.url), "utf8");
    expect(index).toContain("runStep");
    for (const step of ["runIngest", "refitPriceModel", "refreshPriceGrid", "refreshTrends"]) expect(schedule).toContain(step);
    expect(fit).toContain("persistSuggestedAsks");
    expect(asks).not.toContain("refreshPriceGrid");
    expect(functionBody(grid, "gridResponse")).not.toContain("persistSuggestedAsks");
    expect(functionBody(grid, "gridResponse")).not.toContain("ensureArchiveBackfill");
    expect(functionBody(grid, "gridResponse")).not.toContain("env.DB");
    expect(functionBody(grid, "gridResponse")).not.toContain("buildPriceGrid");
    expect(GRID_PULL_SQL).toContain("id > ?");
    expect(GRID_PULL_SQL).toContain("json_extract(payload_json, '$.going_price')");
    expect(GRID_PULL_SQL).not.toMatch(/OFFSET/i);
    expect(GRID_PULL_SQL.replace(/json_extract\(payload_json, '\$\.[^']+'\)/g, "")).not.toContain("payload_json");
    expect(GRID_LISTING_SQL).toContain("price > 0 AND id > ?");
    expect(GRID_LISTING_SQL).not.toMatch(/OFFSET/i);
    const migration = readFileSync(new URL("../migrations/0008_grid_read.sql", import.meta.url), "utf8");
    expect(migration).toContain("idx_price_pulls_grid");
    expect(migration).toContain("idx_price_listings_priced");
    expect(migration).not.toMatch(/UPDATE |DELETE /i);

    const gridAt = index.indexOf('"/api/grid"');
    const exportAt = index.indexOf('"/api/export"');
    expect(gridAt).toBeGreaterThan(0);
    expect(exportAt).toBeGreaterThan(gridAt);
    expect(index.slice(gridAt, exportAt)).toContain("gridResponse");
    expect(index.slice(gridAt, exportAt)).not.toContain("authorizeBearer");
  });
});

function point() {
  return {
    value: 10,
    pulledAt: "2026-10-15T15:00:00.000Z",
    source: "seatdata",
    sourceLabel: "SeatData",
    legacyLabel: null,
    origin: "pull" as const,
    method: null,
  };
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function memoryBook() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function fakeEnv(
  db: DatabaseSync,
  book: ReturnType<typeof memoryBook> = memoryBook(),
  options?: { dbThrows?: boolean },
): Env {
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
    if (options?.dbThrows) {
      throw new Error("d1");
    }
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
        if (options?.dbThrows) throw new Error("d1");
        const results = [];
        for (const statement of statements) {
          results.push(/returning/i.test(statement.sql) ? await statement.all() : await statement.run());
        }
        return results;
      },
    },
    BOOK: book,
  } as unknown as Env;
}
