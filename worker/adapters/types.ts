import type { SpendState } from "../../src/shared/guardrails";
import type { Game } from "../../src/shared/book";

export type MarketPoint = {
  date: string;
  advisedAsk?: number | null;
  getIn?: number | null;
  median?: number | null;
  listingCount?: number | null;
  lastSale?: number | null;
  /** Middle of serious 107/108/118/119 J–T listings. Null clears a stale middle. */
  compMedian?: number | null;
  compCount?: number | null;
  compExcludedDump?: boolean;
};

export type AdapterResult = {
  source: "seatdata" | "apify";
  paid: boolean;
  aborted?: string;
  pulls?: number;
  points: MarketPoint[];
};

export type AdapterContext = {
  env: Env;
  games: Game[];
  now: Date;
  /** Persist spend mid-run so a crash (e.g. CPU limit) cannot lose paid-pull counts. */
  saveSpend?: (spend: SpendState) => Promise<void>;
};

export function dateFromLocal(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}
