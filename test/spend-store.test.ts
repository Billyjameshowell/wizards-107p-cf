import { expect, it, vi } from "vitest";
import { readSpend } from "../worker/store";
import { emptySpendState } from "../src/shared/guardrails";
it("reads daily spend from D1 rather than stale KV", async () => {
  const spend = emptySpendState("2026-09-15");
  spend.sources.seatdata.pullsToday = 25;
  spend.sources.seatdata.lastPullEtDate = "2026-09-15";
  const kvGet = vi.fn();
  const env = { BOOK: { get: kvGet }, DB: { prepare: () => ({
    run: async () => ({}), bind: () => ({ first: async () => ({ value: JSON.stringify(spend) }) }),
  }) } } as unknown as Env;
  const result = await readSpend(env, new Date("2026-09-15T16:00:00Z"));
  expect(result.sources.seatdata.pullsToday).toBe(25);
  expect(kvGet).not.toHaveBeenCalled();
});
