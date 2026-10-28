import { listingsFromUnknown, finiteNumber } from "./archive";
import {
  extractSectionNumber,
  isCompListing,
  normalizeRow,
  pairFromTypeIn,
  roundMoney,
  type CompListing,
} from "./book";
import type { LoggedInstantOffer } from "./instant-offer";
import {
  bandQuote,
  buildTrendsReport,
  modelAskFor,
  type TrendListing,
  type TrendPull,
  type TrendsGameSeed,
} from "./trends";
import { gameMatchesQuery } from "../lib/game-search";

/**
 * Price grid. One cell per game per ET day.
 * Suggested asks are per-seat type-in numbers. A snapshot row is written once
 * and never replaced. Older days are recomputed from the comps known that day.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GRID_METRICS = [
  { id: "suggested", label: "Suggested price", kind: "price" },
  { id: "median", label: "Median", kind: "price" },
  { id: "high", label: "High", kind: "price" },
  { id: "get_in", label: "Get-in", kind: "price" },
  { id: "comps", label: "Comps", kind: "price" },
  { id: "est_ask", label: "Est. ask", kind: "price" },
  { id: "live_ask", label: "Live ask", kind: "price" },
  { id: "ask_per_ticket", label: "Ask per ticket", kind: "price" },
  { id: "listing_count", label: "Listings", kind: "count" },
  { id: "comp_count", label: "Comp count", kind: "count" },
] as const;

export type GridMetricId = (typeof GRID_METRICS)[number]["id"];
export type GridMetricKind = (typeof GRID_METRICS)[number]["kind"];

export type SuggestedOrigin = "snapshot" | "recomputed";
export type SuggestedMethod = "model" | "day-rules";

export type SuggestedAskDraft = {
  externalId: string;
  gameDate: string;
  etDate: string;
  recordedAt: string;
  ask: number;
  origin: SuggestedOrigin;
  source: string;
  pulledAt: string;
  method: SuggestedMethod;
};

export type GridPull = {
  id: number;
  pulledAt: string;
  etDate: string;
  source: string;
  gameDate: string | null;
  opponent: string | null;
  median: number | null;
  getIn: number | null;
  estAsk: number | null;
  liveAsk: number | null;
  listingCount: number | null;
  compCount: number | null;
  legacyLabel: string | null;
  payload: unknown;
  rawKey: string | null;
};

export type GridPoint = {
  value: number;
  pulledAt: string;
  source: string;
  sourceLabel: string;
  legacyLabel: string | null;
  origin: SuggestedOrigin | "pull";
  method: SuggestedMethod | null;
};

export type GridGame = {
  date: string;
  opponent: string;
  weekday: string;
  cells: Record<string, Partial<Record<GridMetricId, GridPoint>>>;
};

export type PriceGrid = {
  asof: string;
  today: string;
  metrics: { id: GridMetricId; label: string; kind: GridMetricKind }[];
  days: string[];
  games: GridGame[];
};

const METRIC_ALIAS: Record<string, GridMetricId> = {
  suggested: "suggested",
  suggestion: "suggested",
  ask: "suggested",
  median: "median",
  high: "high",
  get_in: "get_in",
  getin: "get_in",
  "get-in": "get_in",
  comps: "comps",
  comp: "comps",
  comparable: "comps",
  est_ask: "est_ask",
  est: "est_ask",
  live_ask: "live_ask",
  live: "live_ask",
  ask_per_ticket: "ask_per_ticket",
  listing_count: "listing_count",
  listings: "listing_count",
  comp_count: "comp_count",
};

export function parseGridMetrics(value: string | null | undefined): GridMetricId[] {
  if (!value || !value.trim()) return GRID_METRICS.map((metric) => metric.id);
  const picked: GridMetricId[] = [];
  for (const part of value.split(",")) {
    const key = part.trim().toLowerCase().replace(/\s+/g, "_");
    const id = METRIC_ALIAS[key] ?? METRIC_ALIAS[part.trim().toLowerCase()];
    if (!id || picked.includes(id)) continue;
    picked.push(id);
  }
  return picked.length > 0 ? picked : GRID_METRICS.map((metric) => metric.id);
}

export function suggestedExternalId(gameDate: string, etDate: string): string {
  return `suggested:${gameDate}:${etDate}`;
}

/** First write for a game and day stays. Later plans do not replace it. */
export function firstSuggestedWins(
  existing: readonly SuggestedAskDraft[],
  incoming: readonly SuggestedAskDraft[],
): SuggestedAskDraft[] {
  const seen = new Set(existing.map((row) => row.externalId));
  const kept = existing.slice();
  for (const row of incoming) {
    if (seen.has(row.externalId)) continue;
    seen.add(row.externalId);
    kept.push(row);
  }
  return kept;
}

export function sourceLabel(source: string, legacyLabel?: string | null): string {
  const key = source.trim().toLowerCase();
  if (key === "seatdata") return "SeatData";
  if (key === "apify") return "Apify";
  if (key === "model") return "Model";
  if (key === "book-snapshot") return "Book";
  if (key === "legacy-box") {
    const label = (legacyLabel ?? "").trim();
    if (/seatdata/i.test(label)) return "SeatData";
    if (/seatics|stub\.com/i.test(label)) return "Seatics";
    return label || "Legacy";
  }
  return source || "Unknown";
}

export function formatEtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "AM").toLowerCase();
  return `${hour}:${minute}${period.startsWith("a") ? "a" : "p"}`;
}

/** Exact America/New_York timestamp, labeled ET. */
export function formatEtExact(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
  return text.replace(/\bE[DS]T\b/, "ET");
}

export function pointCaption(point: {
  pulledAt: string | null;
  source: string | null;
  legacyLabel?: string | null;
  origin: string | null;
}): string {
  const when = point.pulledAt ? formatEtExact(point.pulledAt) : "No timestamp";
  const source = sourceLabel(point.source ?? "", point.legacyLabel);
  const bits = [when, source];
  if (point.origin === "recomputed") bits.push("recomputed");
  else if (point.origin === "snapshot") bits.push("snapshot");
  return bits.join(" · ");
}

type AskPlanInput = {
  asOf: string;
  recordedAt: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly TrendPull[];
  listings: readonly TrendListing[];
  instantOffers?: readonly LoggedInstantOffer[];
};

function positive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function payloadMoney(payload: unknown, key: string): number | null {
  return positive(finiteNumber(payloadRecord(payload)?.[key]));
}

function isBandLabel(label: string): boolean {
  const text = label.toLowerCase();
  return text.includes("jt_median") || text.includes("j-t median") || text.includes("107/108/118/119") || text.includes("j-t");
}

function pullsThrough(pulls: readonly TrendPull[], asOf: string): TrendPull[] {
  return pulls.filter((pull) => DAY.test(pull.etDate) && pull.etDate <= asOf);
}

function listingsFor(pulls: readonly TrendPull[], listings: readonly TrendListing[]): TrendListing[] {
  const ids = new Set(pulls.map((pull) => pull.id));
  return listings.filter((row) => ids.has(row.pullId));
}

function dayMayHaveComps(pulls: readonly TrendPull[], listings: readonly TrendListing[], etDate: string): boolean {
  const day = pulls.filter((pull) => pull.etDate === etDate && pull.gameDate);
  if (day.length === 0) return false;
  const ids = new Set(day.map((pull) => pull.id));
  if (listings.some((row) => ids.has(row.pullId))) return true;
  return day.some((pull) => {
    if (pull.source === "apify") return false;
    if (positive(pull.median) != null) return true;
    if (payloadMoney(pull.payload, "going_price") != null) return true;
    return pull.source === "legacy-box" && isBandLabel(pull.legacyLabel ?? "");
  });
}

function compPull(pulls: readonly TrendPull[], gameDate: string, etDate: string): TrendPull | null {
  const rows = pulls
    .filter((pull) => pull.gameDate === gameDate && pull.etDate === etDate)
    .slice()
    .sort((a, b) => a.pulledAt.localeCompare(b.pulledAt));
  if (rows.length === 0) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const pull = rows[index];
    if (!pull) continue;
    if (pull.source === "apify") continue;
    if (positive(pull.median) != null || payloadMoney(pull.payload, "going_price") != null) return pull;
  }
  return rows[rows.length - 1] ?? null;
}

function planOneDay(input: AskPlanInput, origin: SuggestedOrigin, onlyThatDay: boolean): SuggestedAskDraft[] {
  if (!DAY.test(input.asOf)) return [];
  const pulls = pullsThrough(input.pulls, input.asOf);
  const listings = listingsFor(pulls, input.listings);
  const offers = (input.instantOffers ?? []).filter((offer) => offer.observedAt.slice(0, 10) <= input.asOf);
  const report = buildTrendsReport({
    today: input.asOf,
    games: input.games,
    pulls,
    listings,
    instantOffers: offers,
  });
  const rows: SuggestedAskDraft[] = [];
  for (const game of report.games) {
    const onDay = game.series.some((point) => point.date === input.asOf);
    if (onlyThatDay && !onDay) continue;
    const priced = modelAskFor(game, report.outlook);
    if (!priced || !(priced.ask > 0)) continue;
    const pull = compPull(pulls, game.date, input.asOf);
    const source = origin === "snapshot" ? "model" : (pull?.source ?? "model");
    const pulledAt = origin === "snapshot" ? input.recordedAt : (pull?.pulledAt || input.recordedAt);
    rows.push({
      externalId: suggestedExternalId(game.date, input.asOf),
      gameDate: game.date,
      etDate: input.asOf,
      recordedAt: input.recordedAt,
      ask: Math.max(1, Math.round(priced.ask)),
      origin,
      source,
      pulledAt,
      method: "model",
    });
  }
  return rows;
}

/** Today's model ask for each game the model can price. Does not look at later days. */
export function planSnapshotAsks(input: AskPlanInput): SuggestedAskDraft[] {
  return planOneDay(input, "snapshot", false);
}

/**
 * One recomputed ask per game that had comps on a past ET day.
 * Each day is fit only from pulls on or before that day.
 */
export function planRecomputedAsks(input: AskPlanInput & { today: string }): SuggestedAskDraft[] {
  const days = [...new Set(input.pulls.map((pull) => pull.etDate))]
    .filter((day) => DAY.test(day) && day < input.today)
    .filter((day) => dayMayHaveComps(input.pulls, input.listings, day))
    .sort((a, b) => a.localeCompare(b));
  const rows: SuggestedAskDraft[] = [];
  for (const day of days) {
    rows.push(
      ...planOneDay(
        {
          asOf: day,
          recordedAt: input.recordedAt,
          games: input.games,
          pulls: input.pulls,
          listings: input.listings,
          instantOffers: input.instantOffers,
        },
        "recomputed",
        true,
      ),
    );
  }
  return rows;
}

function toComp(row: TrendListing): CompListing {
  return {
    active: row.active === true || row.active === 1 || row.active == null,
    section: row.section ?? undefined,
    row: row.row ?? undefined,
    quantity: row.quantity ?? undefined,
    price: row.price ?? undefined,
  };
}

/** Similar-seat prices, dropping one lone cheap 107 Row P the way the book does. */
function comparablePrices(listings: readonly CompListing[]): number[] {
  const serious = listings.filter((listing) => {
    if (!isCompListing(listing)) return false;
    return typeof listing.price === "number" && Number.isFinite(listing.price) && listing.price > 0;
  });
  if (serious.length === 0) return [];
  const floor = Math.min(...serious.map((listing) => Math.round((listing.price ?? 0) * 100)));
  const atFloor = serious.filter((listing) => Math.round((listing.price ?? 0) * 100) === floor);
  let pool = serious;
  const lone = atFloor[0];
  if (atFloor.length === 1 && lone && extractSectionNumber(lone.section) === "107" && normalizeRow(lone.row) === "P") {
    pool = serious.filter((listing) => listing !== lone);
  }
  return pool
    .map((listing) => listing.price)
    .filter((price): price is number => typeof price === "number" && price > 0);
}

type Stamp = { value: number; pulledAt: string; source: string; legacyLabel: string | null; rank: number };

function prefer(current: Stamp | undefined, next: Stamp): Stamp {
  if (!current) return next;
  if (next.rank !== current.rank) return next.rank > current.rank ? next : current;
  return next.pulledAt >= current.pulledAt ? next : current;
}

function preferHigh(current: Stamp | undefined, next: Stamp): Stamp {
  if (!current) return next;
  if (next.value !== current.value) return next.value > current.value ? next : current;
  return next.pulledAt >= current.pulledAt ? next : current;
}

function pointFrom(stamp: Stamp, origin: GridPoint["origin"], method: GridPoint["method"]): GridPoint {
  return {
    value: stamp.value,
    pulledAt: stamp.pulledAt,
    source: stamp.source,
    sourceLabel: sourceLabel(stamp.source, stamp.legacyLabel),
    legacyLabel: stamp.legacyLabel,
    origin,
    method,
  };
}

function metricKind(id: GridMetricId): GridMetricKind {
  return GRID_METRICS.find((metric) => metric.id === id)?.kind ?? "price";
}

function selectedMetrics(ids: readonly GridMetricId[] | null | undefined): (typeof GRID_METRICS)[number][] {
  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  return GRID_METRICS.filter((metric) => !wanted || wanted.has(metric.id));
}

export function recoverPullMetrics(body: unknown): {
  median: number | null;
  getIn: number | null;
  estAsk: number | null;
  liveAsk: number | null;
  listingCount: number | null;
  compCount: number | null;
  listings: Omit<TrendListing, "pullId">[];
} | null {
  const row = payloadRecord(body);
  if (!row) return null;
  const rawListings = listingsFromUnknown(row.listings ?? row);
  const listings = rawListings.map((listing) => ({
    section: listing.section,
    row: listing.row,
    quantity: listing.quantity,
    price: listing.price,
    active: listing.active,
  }));
  const median = positive(finiteNumber(row.median) ?? finiteNumber(row.comp_median) ?? finiteNumber(row.compMedian));
  const getIn = positive(finiteNumber(row.get_in) ?? finiteNumber(row.getIn));
  const estAsk = positive(finiteNumber(row.est_ask) ?? finiteNumber(row.est_107_ask));
  const liveAsk = positive(finiteNumber(row.live_ask) ?? finiteNumber(row.live_107_ask));
  const listingCount = finiteNumber(row.listing_count ?? row.listingCount);
  const compCount = finiteNumber(row.comp_count ?? row.compCount);
  if (listings.length === 0 && median == null && getIn == null && estAsk == null && liveAsk == null) return null;
  return {
    median,
    getIn,
    estAsk,
    liveAsk,
    listingCount: listingCount != null && listingCount >= 0 ? Math.round(listingCount) : null,
    compCount: compCount != null && compCount >= 0 ? Math.round(compCount) : null,
    listings,
  };
}

export function pullNeedsArchive(pull: GridPull, listingPullIds: ReadonlySet<number>): boolean {
  if (!pull.rawKey) return false;
  if (listingPullIds.has(pull.id)) return false;
  if (positive(pull.median) || positive(pull.getIn) || positive(pull.estAsk) || positive(pull.liveAsk)) return false;
  if (payloadMoney(pull.payload, "going_price") || payloadMoney(pull.payload, "get_in")) return false;
  return true;
}

function countValue(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export function buildPriceGrid(input: {
  now: Date;
  today: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly GridPull[];
  listings: readonly TrendListing[];
  suggested: readonly SuggestedAskDraft[];
  metrics?: readonly GridMetricId[] | null;
  team?: string | null;
}): PriceGrid {
  const metrics = selectedMetrics(input.metrics);
  const metricIds = new Set(metrics.map((metric) => metric.id));
  const listingsByPull = new Map<number, TrendListing[]>();
  for (const row of input.listings) {
    const list = listingsByPull.get(row.pullId) ?? [];
    list.push(row);
    listingsByPull.set(row.pullId, list);
  }

  const pullsByCell = new Map<string, GridPull[]>();
  for (const pull of input.pulls) {
    if (!pull.gameDate || !DAY.test(pull.etDate)) continue;
    const key = `${pull.gameDate}|${pull.etDate}`;
    const list = pullsByCell.get(key) ?? [];
    list.push(pull);
    pullsByCell.set(key, list);
  }

  const suggestedByCell = new Map<string, SuggestedAskDraft>();
  for (const row of input.suggested) {
    if (!DAY.test(row.etDate) || !positive(row.ask)) continue;
    suggestedByCell.set(`${row.gameDate}|${row.etDate}`, row);
  }

  const seeds = new Map<string, TrendsGameSeed>();
  for (const game of input.games) {
    if (DAY.test(game.date)) seeds.set(game.date, game);
  }
  for (const pull of input.pulls) {
    if (!pull.gameDate || !DAY.test(pull.gameDate) || seeds.has(pull.gameDate)) continue;
    seeds.set(pull.gameDate, {
      date: pull.gameDate,
      opponent: pull.opponent?.trim() || "Home game",
      weekday: "",
      timeEt: "",
      type: "",
      demand: null,
      bookMedian: null,
    });
  }

  const team = input.team?.trim() ?? "";
  const days = new Set<string>();
  const games: GridGame[] = [];

  for (const seed of [...seeds.values()].sort((a, b) => a.date.localeCompare(b.date) || a.opponent.localeCompare(b.opponent))) {
    if (team && !gameMatchesQuery({ date: seed.date, weekday: seed.weekday, opponent: seed.opponent, type: seed.type }, team)) {
      continue;
    }
    const cells: GridGame["cells"] = {};
    const dates = new Set<string>();
    for (const key of pullsByCell.keys()) {
      if (key.startsWith(`${seed.date}|`)) dates.add(key.slice(seed.date.length + 1));
    }
    for (const key of suggestedByCell.keys()) {
      if (key.startsWith(`${seed.date}|`)) dates.add(key.slice(seed.date.length + 1));
    }
    for (const etDate of dates) {
      const cell: Partial<Record<GridMetricId, GridPoint>> = {};
      const pulls = pullsByCell.get(`${seed.date}|${etDate}`) ?? [];
      let median: Stamp | undefined;
      let getIn: Stamp | undefined;
      let estAsk: Stamp | undefined;
      let liveAsk: Stamp | undefined;
      let askPerTicket: Stamp | undefined;
      let listingCount: Stamp | undefined;
      let compCount: Stamp | undefined;
      let comps: Stamp | undefined;
      let high: Stamp | undefined;

      for (const pull of pulls) {
        const base = { pulledAt: pull.pulledAt, source: pull.source, legacyLabel: pull.legacyLabel };
        const columnMedian = positive(pull.median);
        if (columnMedian != null) median = prefer(median, { ...base, value: roundMoney(columnMedian), rank: 1 });
        const gotIn = positive(pull.getIn) ?? payloadMoney(pull.payload, "get_in");
        if (gotIn != null) getIn = prefer(getIn, { ...base, value: roundMoney(gotIn), rank: 1 });
        const estimated = positive(pull.estAsk) ?? payloadMoney(pull.payload, "est_107_ask");
        if (estimated != null) estAsk = prefer(estAsk, { ...base, value: roundMoney(estimated), rank: 1 });
        const live = positive(pull.liveAsk) ?? payloadMoney(pull.payload, "live_107_ask");
        if (live != null) liveAsk = prefer(liveAsk, { ...base, value: roundMoney(live), rank: 1 });
        const typed = payloadMoney(pull.payload, "ask_per_ticket");
        if (typed != null) askPerTicket = prefer(askPerTicket, { ...base, value: roundMoney(typed), rank: 1 });
        const listed = countValue(pull.listingCount);
        if (listed != null) listingCount = prefer(listingCount, { ...base, value: listed, rank: 1 });
        const compsN = countValue(pull.compCount);
        if (compsN != null) compCount = prefer(compCount, { ...base, value: compsN, rank: 1 });

        if (columnMedian != null && pull.source !== "apify") {
          const rank = pull.source === "seatdata" || pull.source === "book-snapshot" ? 2 : 1;
          comps = prefer(comps, { ...base, value: roundMoney(columnMedian), rank });
        }
        const going = payloadMoney(pull.payload, "going_price");
        if (going != null) comps = prefer(comps, { ...base, value: roundMoney(going), rank: 3 });
        const quote = bandQuote((listingsByPull.get(pull.id) ?? []).map(toComp));
        if (quote) comps = prefer(comps, { ...base, value: quote.median, rank: 4 });
        const prices = comparablePrices((listingsByPull.get(pull.id) ?? []).map(toComp));
        if (prices.length > 0) {
          high = preferHigh(high, { ...base, value: roundMoney(Math.max(...prices)), rank: 1 });
        }
      }

      const suggested = suggestedByCell.get(`${seed.date}|${etDate}`);
      if (suggested && metricIds.has("suggested")) {
        cell.suggested = {
          value: suggested.ask,
          pulledAt: suggested.pulledAt,
          source: suggested.source,
          sourceLabel: sourceLabel(suggested.source, null),
          legacyLabel: null,
          origin: suggested.origin,
          method: suggested.method,
        };
      }
      if (median && metricIds.has("median")) cell.median = pointFrom(median, "pull", null);
      if (high && metricIds.has("high")) cell.high = pointFrom(high, "pull", null);
      if (getIn && metricIds.has("get_in")) cell.get_in = pointFrom(getIn, "pull", null);
      if (comps && metricIds.has("comps")) cell.comps = pointFrom(comps, "pull", null);
      if (estAsk && metricIds.has("est_ask")) cell.est_ask = pointFrom(estAsk, "pull", null);
      if (liveAsk && metricIds.has("live_ask")) cell.live_ask = pointFrom(liveAsk, "pull", null);
      if (askPerTicket && metricIds.has("ask_per_ticket")) cell.ask_per_ticket = pointFrom(askPerTicket, "pull", null);
      if (listingCount && metricIds.has("listing_count")) cell.listing_count = pointFrom(listingCount, "pull", null);
      if (compCount && metricIds.has("comp_count")) cell.comp_count = pointFrom(compCount, "pull", null);

      if (Object.keys(cell).length > 0) {
        cells[etDate] = cell;
        days.add(etDate);
      }
    }

    games.push({
      date: seed.date,
      opponent: seed.opponent,
      weekday: seed.weekday,
      cells,
    });
  }

  return {
    asof: input.now.toISOString(),
    today: input.today,
    metrics: metrics.map((metric) => ({ id: metric.id, label: metric.label, kind: metric.kind })),
    days: [...days].sort((a, b) => b.localeCompare(a)),
    games,
  };
}

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Cheap view of a stored grid. Drops metrics and games the caller did not ask for.
 * Days stay newest-first. A blank filter returns the same object.
 */
export function slicePriceGrid(
  grid: PriceGrid,
  options?: { metrics?: readonly GridMetricId[] | null; team?: string | null },
): PriceGrid {
  const metrics = selectedMetrics(options?.metrics);
  const fullMetrics = metrics.length === GRID_METRICS.length;
  const team = options?.team?.trim() ?? "";
  if (!team && fullMetrics) return grid;

  const ids = new Set(metrics.map((metric) => metric.id));
  const days = new Set<string>();
  const games: GridGame[] = [];
  for (const game of grid.games) {
    if (team && !gameMatchesQuery({ date: game.date, weekday: game.weekday, opponent: game.opponent }, team)) {
      continue;
    }
    if (fullMetrics) {
      games.push(game);
      for (const day of Object.keys(game.cells)) days.add(day);
      continue;
    }
    const cells: GridGame["cells"] = {};
    for (const [day, cell] of Object.entries(game.cells)) {
      const next: Partial<Record<GridMetricId, GridPoint>> = {};
      for (const id of ids) {
        const point = cell?.[id];
        if (point) next[id] = point;
      }
      if (Object.keys(next).length > 0) {
        cells[day] = next;
        days.add(day);
      }
    }
    games.push({ ...game, cells });
  }
  return {
    asof: grid.asof,
    today: grid.today,
    metrics: metrics.map((metric) => ({ id: metric.id, label: metric.label, kind: metric.kind })),
    days: [...days].sort((a, b) => b.localeCompare(a)),
    games,
  };
}

/** Long CSV: one row per game, day, and selected metric that has a value. */
export function gridToCsv(grid: PriceGrid, options?: { keep?: boolean }): string {
  const header = ["game_date", "opponent", "day", "metric", "per_seat", "keep", "pulled_at", "source", "origin"];
  const lines = [header.join(",")];
  const showKeep = options?.keep === true;
  for (const game of grid.games) {
    for (const day of grid.days) {
      const cell = game.cells[day];
      if (!cell) continue;
      for (const metric of grid.metrics) {
        const point = cell[metric.id];
        if (!point) continue;
        const keep = showKeep && metricKind(metric.id) === "price" ? pairFromTypeIn(point.value) : null;
        lines.push(
          [
            csvCell(game.date),
            csvCell(game.opponent),
            csvCell(day),
            csvCell(metric.label),
            csvCell(point.value),
            csvCell(keep),
            csvCell(point.pulledAt),
            csvCell(point.sourceLabel),
            csvCell(point.origin),
          ].join(","),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
