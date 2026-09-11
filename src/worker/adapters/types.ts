import type { Game } from "@shared/book";

export type MarketPoint = {
  date: string;
  advisedAsk?: number | null;
  getIn?: number | null;
  median?: number | null;
  listingCount?: number | null;
  lastSale?: number | null;
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
};

export function dateFromLocal(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}
