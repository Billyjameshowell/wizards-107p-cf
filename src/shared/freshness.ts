/** How fresh a data source is, plus the shared "3h ago" / "11 days ago" label. */
import type { SourceId } from "./guardrails";

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

/**
 * The one relative-time label for the whole site: minutes under an hour,
 * hours up to 72h, whole days after that ("4m ago", "35h ago", "11 days ago").
 */
export function ageLabel(hours: number): string {
  const minutes = Math.floor(hours * 60);
  if (minutes < 1) return "just now";
  if (hours < 1) return `${minutes}m ago`;
  if (hours < AGING_HOURS) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** Hours since a timestamp (ISO or YYYY-MM-DD), or null when missing or unreadable. */
export function hoursSince(at: string | null | undefined, now: Date = new Date()): number | null {
  const ms = parse(at);
  return ms == null ? null : Math.max(0, (now.getTime() - ms) / 3_600_000);
}

/** Green under 24h, amber 24–72h, red when older or never. */
export function freshness(at: string | null | undefined, now: Date = new Date()): Freshness {
  const hours = hoursSince(at, now);
  if (hours == null) return { tone: "stale", label: "never", hours: null };
  const tone: FreshTone = hours < FRESH_HOURS ? "fresh" : hours < AGING_HOURS ? "aging" : "stale";
  return { tone, label: ageLabel(hours), hours };
}

/** "checked 5h ago" / "checked 11 days ago" / "never checked", same tones as freshness(). */
export function checkedAgo(at: string | null | undefined, now: Date = new Date()): Freshness {
  const base = freshness(at, now);
  if (base.hours == null) return { tone: "stale", label: "never checked", hours: null };
  return { ...base, label: `checked ${base.label}` };
}

/** Red-badge rule: never checked, or 72h and older. */
export function isStaleCheck(at: string | null | undefined, now: Date = new Date()): boolean {
  const hours = freshness(at, now).hours;
  return hours == null || hours >= AGING_HOURS;
}

export type FreshnessSourceRow = {
  source: string;
  lastCheckedAt: string | null;
  ageHours: number | null;
  stale: boolean;
};

export type FreshnessGameRow = {
  date: string;
  opponent: string;
  lastCheckedAt: string | null;
  ageHours: number | null;
  stale: boolean;
};

export type FreshnessReport = {
  asof: string;
  staleAfterHours: number;
  sources: FreshnessSourceRow[];
  games: FreshnessGameRow[];
};

function roundAge(hours: number | null): number | null {
  if (hours == null) return null;
  return Math.round(hours * 10) / 10;
}

function checkedFields(
  at: string | null | undefined,
  now: Date,
): { lastCheckedAt: string | null; ageHours: number | null; stale: boolean } {
  const snap = freshness(at, now);
  return {
    lastCheckedAt: snap.hours == null ? null : (at ?? null),
    ageHours: roundAge(snap.hours),
    stale: snap.hours == null || snap.hours >= AGING_HOURS,
  };
}

/** Public freshness payload for the price sources the worker is set to pull. */
export function buildFreshnessReport(args: {
  now: Date;
  sources: readonly SourceId[];
  games: readonly { date: string; opponent: string; comp_checked_at?: string | null }[];
  sourceCheckedAt?: Readonly<Record<string, string | null | undefined>>;
}): FreshnessReport {
  return {
    asof: args.now.toISOString(),
    staleAfterHours: AGING_HOURS,
    sources: args.sources.map((source) => ({
      source,
      ...checkedFields(args.sourceCheckedAt?.[source], args.now),
    })),
    games: [...args.games]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((game) => ({
        date: game.date,
        opponent: game.opponent,
        ...checkedFields(game.comp_checked_at, args.now),
      })),
  };
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
