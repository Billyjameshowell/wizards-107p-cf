import { etDateFrom } from "./guardrails";

export const LEGACY_SOURCE = "legacy-box";
export const BOOK_SNAPSHOT_SOURCE = "book-snapshot";

export type ArchiveStatus = "ok" | "failed" | "skipped" | "empty";

export type ArchiveListing = {
  section: string | null;
  row: string | null;
  quantity: number | null;
  price: number | null;
  active: number | null;
  extra: Record<string, string | number | boolean | null>;
};

/** One append-only pull. externalId is the idempotency key. */
export type ArchivePull = {
  externalId: string;
  pulledAt: string;
  etDate: string;
  trigger: string;
  source: string;
  gameDate: string | null;
  opponent: string | null;
  status: ArchiveStatus;
  paid: boolean;
  costUsd: number | null;
  httpStatus: number | null;
  error: string | null;
  listingCount: number | null;
  median: number | null;
  getIn: number | null;
  compCount: number | null;
  excludedDump: boolean;
  estAsk: number | null;
  liveAsk: number | null;
  legacyLabel: string | null;
  note: string | null;
  payload: unknown | null;
  listings: ArchiveListing[];
  raw: unknown | null;
};

export type ArchiveSummary = {
  externalId: string;
  pulledAt: string;
  etDate: string;
  source: string;
  sellBookCash: number | null;
  vs6k: number | null;
  payload: unknown;
};

export type ObservedPull = {
  gameDate: string | null;
  opponent?: string | null;
  status: ArchiveStatus;
  paid?: boolean;
  costUsd?: number | null;
  httpStatus?: number | null;
  error?: string | null;
  listings?: unknown;
  raw?: unknown;
  median?: number | null;
  getIn?: number | null;
  compCount?: number | null;
  excludedDump?: boolean;
  listingCount?: number | null;
  note?: string | null;
};

export type ExportFormat = "json" | "csv";
export type ExportTable = "all" | "pulls" | "listings" | "summaries";

export type ExportQuery = {
  format: ExportFormat;
  table: ExportTable;
  game: string | null;
  from: string | null;
  to: string | null;
  source: string | null;
  limit: number;
  offset: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SKIPPED_REASONS = new Set([
  "missing_credential",
  "circuit_open",
  "source_off",
  "ingest_disabled",
  "dry_run",
  "run_pull_cap",
  "day_pull_cap",
]);

export function archiveStatusForAbort(reason: string): "skipped" | "failed" {
  if (SKIPPED_REASONS.has(reason) || reason.endsWith("_cap")) return "skipped";
  return "failed";
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function etDateForInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
  return etDateFrom(parsed);
}

/** "2026-09-22 1:40pm" (America/New_York wall time) → ISO UTC. */
export function etStampToIso(stamp: string): string | null {
  const match = stamp.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(am|pm)$/i);
  if (!match) return null;
  const date = match[1] ?? "";
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const period = (match[4] ?? "").toLowerCase();
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  const wall = `${date}T${pad(hour)}:${pad(minute)}:00`;
  for (const offset of ["-04:00", "-05:00"]) {
    const instant = new Date(`${wall}${offset}`);
    if (Number.isNaN(instant.getTime())) continue;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const asDate = `${get("year")}-${get("month")}-${get("day")}`;
    if (asDate === date && Number(get("hour")) === hour && Number(get("minute")) === minute) {
      return instant.toISOString();
    }
  }
  return null;
}

function activeFlag(value: unknown): number | null {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

export function listingFromUnknown(value: unknown): ArchiveListing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const extra: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(row)) {
    if (key === "section" || key === "row" || key === "quantity" || key === "price" || key === "active") {
      continue;
    }
    if (Object.keys(extra).length >= 30) break;
    if (item == null) {
      extra[key] = null;
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      extra[key] = item;
      continue;
    }
    if (typeof item === "boolean") {
      extra[key] = item;
      continue;
    }
    if (typeof item === "string" && item.length <= 180) extra[key] = item;
  }
  return {
    section: textOrNull(row.section),
    row: textOrNull(row.row),
    quantity: finiteNumber(row.quantity),
    price: finiteNumber(row.price),
    active: activeFlag(row.active),
    extra,
  };
}

export function listingsFromUnknown(value: unknown): ArchiveListing[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { listings?: unknown }).listings)
      ? ((value as { listings: unknown[] }).listings)
      : [];
  const listings: ArchiveListing[] = [];
  for (const item of list) {
    const listing = listingFromUnknown(item);
    if (listing) listings.push(listing);
  }
  return listings;
}

function isGameDate(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value);
}

export function planLegacyArchive(rows: readonly unknown[]): {
  pulls: ArchivePull[];
  summaries: ArchiveSummary[];
} {
  const pulls: ArchivePull[] = [];
  const summaries: ArchiveSummary[] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const record = row as Record<string, unknown>;
    const pulledAt = typeof record.asof_utc === "string" ? record.asof_utc : "";
    if (isGameDate(record.date)) {
      const label = typeof record.source === "string" ? record.source : "";
      pulls.push({
        externalId: `legacy-box:${index}:${pulledAt}:${record.date}:${label}`,
        pulledAt,
        etDate: etDateForInstant(pulledAt),
        trigger: "backfill",
        source: LEGACY_SOURCE,
        gameDate: record.date,
        opponent: textOrNull(record.opponent),
        status: "ok",
        paid: false,
        costUsd: null,
        httpStatus: null,
        error: null,
        listingCount: null,
        median: null,
        getIn: finiteNumber(record.get_in),
        compCount: null,
        excludedDump: false,
        estAsk: finiteNumber(record.est_107_ask),
        liveAsk: finiteNumber(record.live_107_ask),
        legacyLabel: label,
        note: record.carried_forward === true ? "carried_forward" : null,
        payload: record,
        listings: [],
        raw: null,
      });
      return;
    }
    summaries.push({
      externalId: `legacy-box-summary:${index}:${pulledAt}`,
      pulledAt,
      etDate: etDateForInstant(pulledAt),
      source: LEGACY_SOURCE,
      sellBookCash: finiteNumber(record.sell_book_cash),
      vs6k: finiteNumber(record.vs_6k),
      payload: record,
    });
  });
  return { pulls, summaries };
}

function columnSet(columns: readonly string[]): Set<string> {
  return new Set(columns.map((column) => column.toLowerCase()));
}

function cell(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const found = Object.keys(row).find((key) => key.toLowerCase() === name);
  return found ? row[found] : undefined;
}

function detailsObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Copy whatever shape price_history already has. Does not write that table. */
export function planPriceHistoryArchive(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): ArchivePull[] {
  const names = columnSet(columns);
  const daily = names.has("et_date") && names.has("pulled_at");
  const captured = names.has("captured_at");
  const pulls: ArchivePull[] = [];
  for (const row of rows) {
    const gameDate = textOrNull(cell(row, "game_date"));
    const source = textOrNull(cell(row, "source")) ?? "price_history";
    if (!gameDate) continue;
    if (daily) {
      const etDate = textOrNull(cell(row, "et_date")) ?? "";
      const pulledAt = textOrNull(cell(row, "pulled_at")) ?? "";
      pulls.push({
        externalId: `price-history:${gameDate}:${source}:${etDate}`,
        pulledAt,
        etDate,
        trigger: "backfill",
        source,
        gameDate,
        opponent: null,
        status: "ok",
        paid: false,
        costUsd: null,
        httpStatus: null,
        error: null,
        listingCount: finiteNumber(cell(row, "listing_count")),
        median: finiteNumber(cell(row, "median")),
        getIn: finiteNumber(cell(row, "get_in")),
        compCount: finiteNumber(cell(row, "comp_count")),
        excludedDump: cell(row, "excluded_dump") === 1 || cell(row, "excluded_dump") === true,
        estAsk: null,
        liveAsk: null,
        legacyLabel: null,
        note: "preserved from price_history",
        payload: row,
        listings: [],
        raw: null,
      });
      continue;
    }
    if (!captured) continue;
    const pulledAt = textOrNull(cell(row, "captured_at")) ?? "";
    const details = detailsObject(cell(row, "market_details"));
    const listings = listingsFromUnknown(details?.zone_comps);
    pulls.push({
      externalId: `price-history:${gameDate}:${source}:${pulledAt}`,
      pulledAt,
      etDate: etDateForInstant(pulledAt),
      trigger: "backfill",
      source,
      gameDate,
      opponent: null,
      status: listings.length > 0 ? "ok" : "empty",
      paid: false,
      costUsd: null,
      httpStatus: null,
      error: null,
      listingCount: finiteNumber(cell(row, "listing_count")) ?? (listings.length > 0 ? listings.length : null),
      median: finiteNumber(cell(row, "median")),
      getIn: finiteNumber(cell(row, "get_in")),
      compCount: finiteNumber(details?.zone_comp_count),
      excludedDump: false,
      estAsk: finiteNumber(cell(row, "advised_ask")),
      liveAsk: null,
      legacyLabel: null,
      note: "preserved from price_history",
      payload: details ? { ...row, market_details: details } : row,
      listings,
      raw: null,
    });
  }
  return pulls;
}

function snapshotPull(
  game: Record<string, unknown>,
  slot: "current" | "previous",
  details: Record<string, unknown>,
): ArchivePull | null {
  const gameDate = textOrNull(game.date);
  if (!gameDate) return null;
  const stamp =
    textOrNull(details.asof) ??
    (slot === "current" ? textOrNull(game.market_updated_at_et) : null) ??
    "";
  const pulledAt = (stamp && etStampToIso(stamp)) || (stamp ? `${stamp}` : "");
  const etDate = isGameDate(stamp.slice(0, 10))
    ? stamp.slice(0, 10)
    : etDateForInstant(pulledAt);
  const listings = listingsFromUnknown(details.zone_comps);
  const zoneMedian = finiteNumber(details.zone_median);
  const zoneGetIn = finiteNumber(details.zone_get_in);
  return {
    externalId: `book-snapshot:${slot}:${gameDate}:${stamp || pulledAt}`,
    pulledAt,
    etDate,
    trigger: "backfill",
    source: BOOK_SNAPSHOT_SOURCE,
    gameDate,
    opponent: textOrNull(game.opponent),
    status: listings.length > 0 ? "ok" : "empty",
    paid: false,
    costUsd: null,
    httpStatus: null,
    error: null,
    listingCount: listings.length > 0 ? listings.length : finiteNumber(details.zone_comp_count),
    median: zoneMedian ?? finiteNumber(details.median),
    getIn: zoneGetIn ?? finiteNumber(details.get_in),
    compCount: finiteNumber(details.zone_comp_count),
    excludedDump: false,
    estAsk: null,
    liveAsk: null,
    legacyLabel: slot === "current" ? "market_details" : "market_previous_details",
    note:
      listings.length > 0
        ? "zone comps kept on the live book (that writer stored at most 50)"
        : "book market snapshot had no zone comps",
    payload: details,
    listings,
    raw: null,
  };
}

/** Latest and previous zone comps currently sitting on the book JSON. */
export function planBookSnapshots(book: unknown): ArchivePull[] {
  if (!book || typeof book !== "object" || Array.isArray(book)) return [];
  const games = (book as { games?: unknown }).games;
  if (!Array.isArray(games)) return [];
  const pulls: ArchivePull[] = [];
  for (const game of games) {
    if (!game || typeof game !== "object") continue;
    const record = game as Record<string, unknown>;
    const current = detailsObject(record.market_details);
    const previous = detailsObject(record.market_previous_details);
    if (current) {
      const pull = snapshotPull(record, "current", current);
      if (pull) pulls.push(pull);
    }
    if (previous) {
      const pull = snapshotPull(record, "previous", previous);
      if (pull) pulls.push(pull);
    }
  }
  return pulls;
}

export function planObservedPulls(args: {
  source: string;
  trigger: string;
  now: Date;
  rows: readonly ObservedPull[];
  ids: readonly string[];
}): ArchivePull[] {
  const pulledAt = args.now.toISOString();
  const etDate = etDateFrom(args.now);
  return args.rows.map((row, index) => {
    const listings = listingsFromUnknown(row.listings);
    const listingCount =
      row.listingCount != null
        ? row.listingCount
        : listings.length > 0
          ? listings.length
          : null;
    return {
      externalId: args.ids[index] ?? `observed:${args.source}:${pulledAt}:${index}`,
      pulledAt,
      etDate,
      trigger: args.trigger,
      source: args.source,
      gameDate: row.gameDate,
      opponent: row.opponent ?? null,
      status: row.status,
      paid: row.paid === true,
      costUsd: finiteNumber(row.costUsd),
      httpStatus: row.httpStatus ?? null,
      error: row.error ?? null,
      listingCount,
      median: finiteNumber(row.median),
      getIn: finiteNumber(row.getIn),
      compCount: finiteNumber(row.compCount),
      excludedDump: row.excludedDump === true,
      estAsk: null,
      liveAsk: null,
      legacyLabel: null,
      note: row.note ?? null,
      payload: null,
      listings,
      raw: row.raw ?? null,
    };
  });
}

export function parseExportQuery(params: URLSearchParams): ExportQuery | { error: string } {
  const formatParam = (params.get("format") ?? "json").toLowerCase();
  if (formatParam !== "json" && formatParam !== "csv") {
    return { error: "format must be json or csv" };
  }
  const tableParam = (params.get("table") ?? (formatParam === "csv" ? "listings" : "all")).toLowerCase();
  if (
    tableParam !== "all" &&
    tableParam !== "pulls" &&
    tableParam !== "listings" &&
    tableParam !== "summaries"
  ) {
    return { error: "table must be all, pulls, listings, or summaries" };
  }
  if (formatParam === "csv" && tableParam === "all") {
    return { error: "csv export needs table=pulls, listings, or summaries" };
  }
  const from = params.get("from");
  const to = params.get("to");
  const game = params.get("game") ?? params.get("game_date");
  if (from && !DAY.test(from)) return { error: "from must be YYYY-MM-DD" };
  if (to && !DAY.test(to)) return { error: "to must be YYYY-MM-DD" };
  if (game && !DAY.test(game)) return { error: "game must be YYYY-MM-DD" };
  const source = params.get("source");
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw == null || limitRaw === "" ? 500 : Number(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    return { error: "limit must be an integer from 1 to 2000" };
  }
  if (!Number.isInteger(offset) || offset < 0) return { error: "offset must be an integer >= 0" };
  return {
    format: formatParam,
    table: tableParam,
    game: game ?? null,
    from: from ?? null,
    to: to ?? null,
    source: source && source.trim() !== "" ? source.trim() : null,
    limit,
    offset,
  };
}

export type SqlFilter = { sql: string; binds: (string | number)[] };

/** Filters apply to price_pulls columns. Prefix them with the given alias. */
export function pullFilter(query: ExportQuery, alias = "p"): SqlFilter {
  const clauses: string[] = [];
  const binds: string[] = [];
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  if (query.game) {
    clauses.push(`${column("game_date")} = ?`);
    binds.push(query.game);
  }
  if (query.source) {
    clauses.push(`${column("source")} = ?`);
    binds.push(query.source);
  }
  if (query.from) {
    clauses.push(`${column("et_date")} >= ?`);
    binds.push(query.from);
  }
  if (query.to) {
    clauses.push(`${column("et_date")} <= ?`);
    binds.push(query.to);
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    binds,
  };
}

export const LISTING_CSV_COLUMNS = [
  "pull_id",
  "pulled_at",
  "et_date",
  "source",
  "legacy_label",
  "game_date",
  "opponent",
  "status",
  "paid",
  "cost_usd",
  "median",
  "get_in",
  "comp_count",
  "est_ask",
  "live_ask",
  "section",
  "row",
  "quantity",
  "price",
  "active",
  "extra_json",
] as const;

export const PULL_CSV_COLUMNS = [
  "id",
  "pulled_at",
  "et_date",
  "trigger_name",
  "source",
  "legacy_label",
  "game_date",
  "opponent",
  "status",
  "paid",
  "cost_usd",
  "http_status",
  "error",
  "listing_count",
  "median",
  "get_in",
  "comp_count",
  "excluded_dump",
  "est_ask",
  "live_ask",
  "note",
  "raw_key",
  "payload_json",
] as const;

export const SUMMARY_CSV_COLUMNS = [
  "id",
  "pulled_at",
  "et_date",
  "source",
  "sell_book_cash",
  "vs_6k",
  "payload_json",
] as const;

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
