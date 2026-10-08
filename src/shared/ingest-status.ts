import { etStampToIso } from "./archive";

/** A pull older than this is called out on the admin status page. */
export const STALE_PULL_MS = 3 * 24 * 60 * 60 * 1000;

export type IngestStatusInput = {
  ingestEnabled: boolean;
  dryRun: boolean;
  /** ISO time of the last successful SeatData or Apify pull, if one is known. */
  lastPullAt: string | null;
  now: Date;
};

function instantMs(value: string): number | null {
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : etStampToIso(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Latest parseable timestamp. Display stamps and ISO strings both count. */
export function latestInstant(values: readonly (string | null | undefined)[]): string | null {
  let bestMs: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const ms = instantMs(value);
    if (ms == null) continue;
    if (bestMs == null || ms > bestMs) bestMs = ms;
  }
  return bestMs == null ? null : new Date(bestMs).toISOString();
}

/** Times on the live book that mean a pull actually wrote prices. */
export function bookPullInstants(book: unknown): string[] {
  if (!book || typeof book !== "object") return [];
  const record = book as Record<string, unknown>;
  const found: string[] = [];
  if (typeof record.asof_et === "string") found.push(record.asof_et);
  if (!Array.isArray(record.games)) return found;
  for (const game of record.games) {
    if (!game || typeof game !== "object") continue;
    const row = game as Record<string, unknown>;
    if (typeof row.comp_checked_at === "string") found.push(row.comp_checked_at);
    if (typeof row.market_updated_at_et === "string") found.push(row.market_updated_at_et);
    const details = row.market_details;
    if (details && typeof details === "object" && typeof (details as { asof?: unknown }).asof === "string") {
      found.push((details as { asof: string }).asof);
    }
  }
  return found;
}

export function ingestStatusWarnings(input: IngestStatusInput): string[] {
  const warnings: string[] = [];
  if (!input.ingestEnabled) {
    warnings.push("Ingest is off, so the morning job will not pull prices.");
  }
  if (input.dryRun) {
    warnings.push("Dry run is on, so the morning job will not call SeatData or Apify.");
  }
  const lastMs = input.lastPullAt ? instantMs(input.lastPullAt) : null;
  if (lastMs == null) {
    warnings.push("No successful pull is on record.");
    return warnings;
  }
  const ageMs = input.now.getTime() - lastMs;
  if (ageMs > STALE_PULL_MS) {
    const days = Math.floor(ageMs / 86_400_000);
    warnings.push(`Last successful pull was ${days} days ago.`);
  }
  return warnings;
}
