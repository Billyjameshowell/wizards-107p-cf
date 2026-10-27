import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCompHistory, recordPriceHistory, type PriceHistoryWrite } from "../worker/store";

// The table production created on 2026-09-15, before 0002 was rewritten.
const LEGACY_PRICE_HISTORY = `CREATE TABLE price_history (
  game_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seatdata', 'apify')),
  captured_at TEXT NOT NULL,
  advised_ask REAL,
  get_in REAL,
  median REAL,
  listing_count INTEGER,
  last_sale REAL,
  market_details TEXT,
  PRIMARY KEY (game_date, source, captured_at)
)`;

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

/** Just enough of D1 for store.ts: prepare/bind/run/all and batch. No exec, as in a Worker it is not needed. */
function d1(db: DatabaseSync): Env {
  const statement = (sql: string, params: unknown[]) => ({
    sql,
    run: async () => {
      db.prepare(sql).run(...(params as never[]));
      return { results: [], meta: {} };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])), meta: {} }),
  });
  return {
    DB: {
      prepare: (sql: string) => ({ ...statement(sql, []), bind: (...params: unknown[]) => statement(sql, params) }),
      batch: async (statements: { run: () => Promise<unknown> }[]) => {
        const results = [];
        for (const s of statements) results.push(await s.run());
        return results;
      },
    },
  } as unknown as Env;
}

const now = new Date("2026-10-27T12:00:39.328Z");
const rows: PriceHistoryWrite[] = [
  {
    gameDate: "2026-11-04",
    source: "seatdata",
    etDate: "2026-10-27",
    pulledAt: now.toISOString(),
    median: 78.04,
    getIn: 33.28,
    listingCount: 40,
    compCount: 18,
    excludedDump: false,
  },
];

async function roundTrip(db: DatabaseSync) {
  const env = d1(db);
  await recordPriceHistory(env, rows, now);
  // A second check the same ET day replaces the first.
  await recordPriceHistory(env, [{ ...rows[0], median: 80 }], now);
  return readCompHistory(env, "2026-10-27");
}

describe("price_history schema (0010)", () => {
  it("rebuilds the legacy production table and keeps its rows", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LEGACY_PRICE_HISTORY);
    db.prepare(
      "INSERT INTO price_history (game_date, source, captured_at, median) VALUES ('2026-11-04', 'seatdata', '2026-09-22T17:41:01.607Z', 71.55)",
    ).run();
    // Before the migration, the write fails the way it did every morning from Oct 21.
    await expect(recordPriceHistory(d1(db), rows, now)).rejects.toThrow(/et_date/);

    db.exec(migration("0010_price_history_schema.sql"));
    const history = await roundTrip(db);
    expect(history.get("2026-11-04")).toHaveLength(1);
    expect(history.get("2026-11-04")?.[0]).toMatchObject({ etDate: "2026-10-27", median: 80 });
    expect(db.prepare("SELECT count(*) AS n FROM price_history_legacy").get()).toEqual({ n: 1 });
  });

  it("applies cleanly on a database built from every migration", async () => {
    const db = new DatabaseSync(":memory:");
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort();
    for (const name of names) db.exec(migration(name));
    const history = await roundTrip(db);
    expect(history.get("2026-11-04")?.[0]).toMatchObject({ etDate: "2026-10-27", median: 80 });
  });
});
