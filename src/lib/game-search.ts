const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const WEEKDAY_FULL: Record<string, string> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
};

export type GameSearchable = {
  date: string;
  weekday?: string;
  opponent: string;
  type?: string;
  notes?: string;
  sitOrSell?: string;
};

function datePhrases(date: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return [date];
  const year = match[1] ?? "";
  const monthText = match[2] ?? "";
  const dayText = match[3] ?? "";
  const month = Number(monthText);
  const day = Number(dayText);
  const name = MONTHS[month - 1] ?? "";
  return [
    date,
    `${name} ${day}`,
    `${name} ${dayText}`,
    `${month}/${day}`,
    `${monthText}/${dayText}`,
    `${month}/${day}/${year}`,
    `${monthText}/${dayText}/${year}`,
    `${name} ${day} ${year}`,
  ];
}

function weekdayPhrases(weekday: string): string[] {
  const raw = weekday.trim().toLowerCase();
  if (!raw) return [];
  const full = WEEKDAY_FULL[raw.slice(0, 3)];
  if (!full || full === raw) return [raw];
  return [raw, full];
}

/** Lowercase text the book search compares against a typed query. */
export function gameSearchText(game: GameSearchable): string {
  const parts = [
    game.opponent,
    game.weekday ?? "",
    ...weekdayPhrases(game.weekday ?? ""),
    game.type ?? "",
    game.notes ?? "",
    game.sitOrSell ?? "",
    ...datePhrases(game.date),
  ];
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

const DECISION = new Set(["sit", "sell", "tbd"]);

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

/** Case-insensitive match on team, date, weekday, type, notes, and Sit/Sell. */
export function gameMatchesQuery(game: GameSearchable, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!needle) return true;
  if (DECISION.has(needle)) {
    const decision = (game.sitOrSell ?? "").trim().toLowerCase();
    return decision === needle || hasWord(game.notes ?? "", needle);
  }
  return gameSearchText(game).includes(needle);
}
