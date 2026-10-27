import { runIngest } from "./ingest";
import { refitPriceModel } from "./model-fit";
import { refreshPriceGrid } from "./grid";
import { persistSuggestedAsks } from "./suggested-asks";
import { syncSalesFromBook } from "./sales";
import { refreshTrends } from "./trends";

/**
 * The morning job runs as four separate cron invocations, so each one gets its own
 * CPU and subrequest budget. One invocation doing all four started ending in
 * exceededCpu on 2026-10-22, once the listings archive passed about 70k rows.
 *
 * The cron's minute picks the step; the hour is when the chain runs. Steps read
 * what the step before them saved, so keep them in this order and a few minutes apart.
 */
export const STEPS = ["ingest", "refit", "grid", "trends"] as const;
export type Step = (typeof STEPS)[number];

const STEP_BY_MINUTE: Record<string, Step> = { "0": "ingest", "10": "refit", "20": "grid", "30": "trends" };

export function stepForCron(cron: string): Step | null {
  const minute = cron.trim().split(/\s+/)[0] ?? "";
  return STEP_BY_MINUTE[minute] ?? null;
}

export function isStep(value: string | null): value is Step {
  return value != null && (STEPS as readonly string[]).includes(value);
}

export async function runStep(step: Step, env: Env, trigger: "cron" | "http", now = new Date()): Promise<unknown> {
  const started = Date.now();
  try {
    switch (step) {
      case "ingest": {
        // Comps pull, raw archive, price history, book. Sales sync rides along (a few rows).
        const [summary] = await Promise.all([
          runIngest(env, trigger, now),
          syncSalesFromBook(env).catch((error) => console.error("sales sync", error)),
        ]);
        return summary;
      }
      case "refit":
        // Model fit and likely sales.
        return await refitPriceModel(env, trigger, now);
      case "grid":
        // Today's suggested-ask snapshot, then the grid built from it.
        try {
          await persistSuggestedAsks(env, now, { fillToday: true });
        } catch (error) {
          console.error("suggested asks", error);
        }
        return await refreshPriceGrid(env, now);
      case "trends":
        await refreshTrends(env, now);
        return { refreshed: true };
    }
  } finally {
    console.log(JSON.stringify({ step, trigger, ms: Date.now() - started }));
  }
}
