import type { Game, ListingOverride } from "@shared/book";

export type SortKey =
  | "date"
  | "opponent"
  | "type"
  | "time"
  | "sit_or_sell"
  | "advised_ask"
  | "cash"
  | "listed"
  | "sold"
  | "ticketdata"
  | "notes";

export type SortDirection = "asc" | "desc";

export type GameSort = {
  key: SortKey;
  direction: SortDirection;
};

export const DEFAULT_GAME_SORT: GameSort = { key: "date", direction: "asc" };

export const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "opponent", label: "Opponent" },
  { key: "type", label: "Type" },
  { key: "time", label: "Time" },
  { key: "sit_or_sell", label: "Sit/Sell" },
  { key: "advised_ask", label: "Advised ask" },
  { key: "cash", label: "Cash both after 10%" },
  { key: "listed", label: "Listed?" },
  { key: "sold", label: "Sold?" },
  { key: "ticketdata", label: "TicketData" },
  { key: "notes", label: "Notes" },
];

export type SortableGameRow = {
  game: Game;
  status: Pick<ListingOverride, "listed" | "sold" | "notes">;
};

export function toggleSort(current: GameSort, key: SortKey): GameSort {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function timeToMinutes(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
  const period = match[3].toUpperCase();
  if (hours === 12) hours = 0;
  if (period === "PM") hours += 12;
  return hours * 60 + minutes;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function blanksLast(aBlank: boolean, bBlank: boolean): number | null {
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  return null;
}

function directed(result: number, direction: SortDirection): number {
  if (result === 0) return 0;
  return direction === "asc" ? result : -result;
}

function isBlankNumber(value: number | null | undefined): boolean {
  return value == null || Number.isNaN(value);
}

function primaryCompare(rowA: SortableGameRow, rowB: SortableGameRow, sort: GameSort): number {
  const a = rowA.game;
  const b = rowB.game;
  switch (sort.key) {
    case "date":
      return directed(a.date.localeCompare(b.date), sort.direction);
    case "opponent":
      return directed(compareText(a.opponent, b.opponent), sort.direction);
    case "type":
      return directed(compareText(a.type, b.type), sort.direction);
    case "time": {
      const aMin = timeToMinutes(a.time_et);
      const bMin = timeToMinutes(b.time_et);
      const blank = blanksLast(aMin == null, bMin == null);
      if (blank !== null) return blank;
      return directed((aMin ?? 0) - (bMin ?? 0), sort.direction);
    }
    case "sit_or_sell":
      return directed(compareText(a.sit_or_sell, b.sit_or_sell), sort.direction);
    case "advised_ask":
    case "cash": {
      const aVal = sort.key === "advised_ask" ? a.advised_ask : a.cash_both_after_fee;
      const bVal = sort.key === "advised_ask" ? b.advised_ask : b.cash_both_after_fee;
      const blank = blanksLast(isBlankNumber(aVal), isBlankNumber(bVal));
      if (blank !== null) return blank;
      return directed((aVal ?? 0) - (bVal ?? 0), sort.direction);
    }
    case "listed":
      return directed(Number(rowA.status.listed) - Number(rowB.status.listed), sort.direction);
    case "sold":
      return directed(Number(rowA.status.sold) - Number(rowB.status.sold), sort.direction);
    case "ticketdata": {
      const aUrl = a.ticketdata_url ?? "";
      const bUrl = b.ticketdata_url ?? "";
      const blank = blanksLast(aUrl === "", bUrl === "");
      if (blank !== null) return blank;
      return directed(compareText(aUrl, bUrl), sort.direction);
    }
    case "notes": {
      const aNotes = rowA.status.notes ?? "";
      const bNotes = rowB.status.notes ?? "";
      const blank = blanksLast(aNotes.trim() === "", bNotes.trim() === "");
      if (blank !== null) return blank;
      return directed(compareText(aNotes, bNotes), sort.direction);
    }
    default: {
      const exhaustive: never = sort.key;
      return exhaustive;
    }
  }
}

export function sortGameRows<T extends SortableGameRow>(rows: readonly T[], sort: GameSort): T[] {
  return [...rows].sort((a, b) => {
    const primary = primaryCompare(a, b, sort);
    if (primary !== 0) return primary;
    const byDate = a.game.date.localeCompare(b.game.date);
    if (byDate !== 0) return byDate;
    return compareText(a.game.opponent, b.game.opponent);
  });
}
