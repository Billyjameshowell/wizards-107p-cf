import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSpendLedger, readSpendTotals, reconcileSpend, reserveSpend } from "../worker/spend";

function database() {
  const db = new DatabaseSync(":memory:");
  const env = { DB: { prepare(sql: string) {
    const statement = (values: (string | number | null)[] = []) => ({
      bind: (...args: (string | number | null)[]) => statement(args),
      run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
    });
    return statement();
  } } } as unknown as Env;
  return { db, env };
}

describe("durable billing ledger using SQLite", () => {
  it("retains interrupted reservations, then replaces estimates with actual without double counting", async () => {
    const { db, env } = database();
    const id = await reserveSpend(env, { id: "stable-id", source: "apify", etDate: "2026-09-15", reservedUsd: 0.5 });
    await reserveSpend(env, { id, source: "apify", etDate: "2026-09-15", reservedUsd: 0.5 });
    expect((await readSpendTotals(env, "2026-09-15")).blended.estimatedUsd).toBe(0.5);
    await reconcileSpend(env, id, { actualUsd: 0.175, details: { status: "SUCCEEDED", eventsFetched: 43 } });
    const totals = await readSpendTotals(env, "2026-09-15");
    expect(totals.blended).toMatchObject({ actualUsd: 0.175, estimatedUsd: 0, reservedUsd: 0.5, pulls: 1, eventsFetched: 43 });
    expect((await readSpendTotals(env, "2026-09-16")).blended.actualUsd).toBe(0);
    expect(await readSpendLedger(env)).toHaveLength(1);
    db.close();
  });

  it("totals the entire ET day even when recent history is limited", async () => {
    const { db, env } = database();
    await reserveSpend(env, { source: "seatdata", etDate: "2026-09-15", reservedUsd: 0.04 });
    const insert = db.prepare("INSERT INTO spend_pulls VALUES (?, 'seatdata', '2026-09-15', '2026-09-15T12:00:00Z', 0.04, 0, 0.04, '{}')");
    for (let i = 0; i < 510; i++) insert.run(`pull-${i}`);
    const total = (await readSpendTotals(env, "2026-09-15")).blended;
    expect(total.actualUsd).toBeCloseTo(20.4);
    expect(total.estimatedUsd).toBe(0.04);
    expect(total.pulls).toBe(511);
    expect(await readSpendLedger(env, { limit: 5 })).toHaveLength(5);
    db.close();
  });

  it("imports legacy counters once as estimates and counts historical pulls correctly", async () => {
    const { db, env } = database();
    db.exec("CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
    db.prepare("INSERT INTO store VALUES ('spend', ?, '2026-09-15T12:00:00Z')").run(JSON.stringify({ etDate: "2026-09-15", sources: { seatdata: { pullsToday: 25 }, apify: { paidAttemptsToday: 1 } } }));
    const migration = readFileSync(new URL("../migrations/0003_spend_pulls.sql", import.meta.url), "utf8");
    db.exec(migration);
    db.exec(migration);
    const total = await readSpendTotals(env, "2026-09-15");
    expect(total.blended.actualUsd).toBe(0);
    expect(total.blended.estimatedUsd).toBe(1.5);
    expect(total.sources.seatdata.pulls).toBe(25);
    expect(await readSpendLedger(env)).toHaveLength(2);
    db.close();
  });
});
