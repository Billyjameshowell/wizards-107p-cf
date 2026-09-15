import type { Game, MarketDetails } from "../../src/shared/book";

export type MarketPoint = {
  date: string;
  advisedAsk?: number | null;
  getIn?: number | null;
  median?: number | null;
  listingCount?: number | null;
  lastSale?: number | null;
  marketDetails?: MarketDetails | null;
};

export type AdapterResult = {
  source: "seatdata" | "apify";
  paid: boolean;
  aborted?: string;
  pulls?: number;
  points: MarketPoint[];
  spend?: {
    actualUsd: number;
    estimatedUsd: number;
    reservedUsd: number;
    eventsFetched: number;
    pulls: number;
    runId?: string;
    status?: string;
    stats?: unknown;
  };
};

export type AdapterContext = {
  env: Env;
  games: Game[];
  now: Date;
  /** One-shot seed mode. The caller claims this mode before creating context. */
  seed?: boolean;
};

export function dateFromLocal(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}
