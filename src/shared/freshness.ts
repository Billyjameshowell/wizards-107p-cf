/** How fresh a data source is, for the small "updated 3h ago" badges. */
export type FreshTone = "fresh" | "aging" | "stale";

export const FRESH_HOURS = 24;
export const AGING_HOURS = 72;

export type Freshness = { tone: FreshTone; label: string; hours: number | null };

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  // A bare day (YYYY-MM-DD) means "sometime that day"; read it as noon ET.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T16:00:00Z` : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function ageLabel(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Green under 24h, amber 24–72h, red when older or never. */
export function freshness(at: string | null | undefined, now: Date = new Date()): Freshness {
  const ms = parse(at);
  if (ms == null) return { tone: "stale", label: "never", hours: null };
  const hours = Math.max(0, (now.getTime() - ms) / 3_600_000);
  const tone: FreshTone = hours < FRESH_HOURS ? "fresh" : hours < AGING_HOURS ? "aging" : "stale";
  return { tone, label: ageLabel(hours), hours };
}

/** Latest of several timestamps (ISO or YYYY-MM-DD), or null. */
export function latestOf(values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = parse(value);
    if (ms != null && ms > bestMs) {
      bestMs = ms;
      best = value ?? null;
    }
  }
  return best;
}
