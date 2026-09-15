import { describe, expect, it, vi } from "vitest";
import seed from "../data/seed-book.json";
import type { Book } from "../src/shared/book";
import { writeBookAndHistory, type PriceHistorySnapshot } from "../worker/store";

const observation: PriceHistorySnapshot = {
  gameDate: seed.games[0].date, source: "seatdata", capturedAt: "2026-09-15T16:00:00Z",
  advisedAsk: 100, getIn: 20, median: 60, listingCount: null, lastSale: null, marketDetails: null,
};
function database(fail = false) {
  const batch = vi.fn(async () => { if (fail) throw new Error("database unavailable"); return []; });
  const put = vi.fn(async () => {});
  const prepare = vi.fn((sql: string) => ({ sql, run: vi.fn(async () => ({})), bind: (...args: unknown[]) => ({ sql, args }) }));
  return { batch, put, env: { DB: { prepare, batch }, BOOK: { put } } as unknown as Env };
}
describe("durable history writes", () => {
  it("commits book and observed prices in one batch before mirroring to KV", async () => {
    const db = database();
    await writeBookAndHistory(db.env, seed as Book, [observation]);
    expect(db.batch).toHaveBeenCalledOnce();
    const statements = db.batch.mock.calls[0] as unknown as [Array<{ sql: string; args: unknown[] }>];
    expect(statements[0]).toHaveLength(2);
    expect(statements[0][0].sql).toContain("INSERT INTO store");
    expect(statements[0][1].sql).toContain("INSERT INTO price_history");
    expect(statements[0][1].sql).toContain("DO NOTHING");
    expect(db.put.mock.invocationCallOrder[0]).toBeGreaterThan(db.batch.mock.invocationCallOrder[0]);
  });
  it("does not publish a book to KV when its history transaction fails", async () => {
    const db = database(true);
    await expect(writeBookAndHistory(db.env, seed as Book, [observation])).rejects.toThrow("database unavailable");
    expect(db.put).not.toHaveBeenCalled();
  });
});
