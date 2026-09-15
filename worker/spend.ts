/**
 * Durable provider cost ledger.
 *
 * The normal spend state is a compact guardrail snapshot. This table is the
 * appendable audit trail used by admin reporting: each paid pull gets one
 * stable row, reserved before the network call and reconciled afterwards.
 */

export type SpendSource = "seatdata" | "apify";

export type SpendLedgerRow = {
  id: string;
  source: SpendSource;
  etDate: string;
  at: string;
  actualUsd: number;
  estimatedUsd: number;
  reservedUsd: number;
  details: Record<string, unknown>;
};

export type SpendReservation = {
  id?: string;
  source: SpendSource;
  etDate: string;
  reservedUsd: number;
  details?: Record<string, unknown>;
  at?: string;
};

export type SpendReconciliation = {
  actualUsd: number;
  estimatedUsd?: number;
  reservedUsd?: number;
  details?: Record<string, unknown>;
};

export type SpendLedgerQuery = {
  etDate?: string;
  source?: SpendSource;
  limit?: number;
};

export type SpendSourceTotals = {
  actualUsd: number;
  estimatedUsd: number;
  reservedUsd: number;
  pulls: number;
  eventsFetched: number;
};

export type SpendTotals = {
  etDate: string;
  sources: Record<SpendSource, SpendSourceTotals>;
  blended: SpendSourceTotals;
};

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS spend_pulls (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('seatdata', 'apify')),
  et_date TEXT NOT NULL,
  at TEXT NOT NULL,
  actual_usd REAL NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}'
)`;

const INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_spend_pulls_et_source_at
  ON spend_pulls (et_date, source, at DESC)`;

function hasDatabase(env: Env): boolean {
  const database = (env as Partial<Env>).DB;
  return Boolean(database && typeof database.prepare === "function");
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 10000) / 10000
    : 0;
}

function limitValue(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null) return 100;
  return Math.min(500, Math.max(1, Math.floor(value)));
}

function parseDetails(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function serializeDetails(details: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(details ?? {});
  } catch {
    return "{}";
  }
}

export async function ensureSpendLedger(env: Env): Promise<void> {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(TABLE_SQL).run();
  await env.DB.prepare(INDEX_SQL).run();
}

export async function reserveSpend(
  env: Env,
  reservation: SpendReservation,
): Promise<string> {
  const id = reservation.id ?? crypto.randomUUID();
  if (!hasDatabase(env)) return id;
  await ensureSpendLedger(env);
  const at = reservation.at ?? new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO spend_pulls
       (id, source, et_date, at, actual_usd, estimated_usd, reserved_usd, details)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    id,
    reservation.source,
    reservation.etDate,
    at,
    amount(reservation.reservedUsd),
    amount(reservation.reservedUsd),
    serializeDetails(reservation.details),
  ).run();
  return id;
}

export async function reconcileSpend(
  env: Env,
  id: string,
  reconciliation: SpendReconciliation,
): Promise<void> {
  if (!hasDatabase(env)) return;
  await ensureSpendLedger(env);
  const existing = await env.DB.prepare(
    "SELECT details, reserved_usd FROM spend_pulls WHERE id = ?",
  ).bind(id).first<{ details?: string; reserved_usd?: number }>();
  if (!existing) return;
  const mergedDetails = {
    ...parseDetails(existing.details),
    ...(reconciliation.details ?? {}),
  };
  await env.DB.prepare(
    `UPDATE spend_pulls
        SET actual_usd = ?, estimated_usd = ?, reserved_usd = ?, details = ?
      WHERE id = ?`,
  ).bind(
    amount(reconciliation.actualUsd),
    amount(reconciliation.estimatedUsd ?? 0),
    amount(reconciliation.reservedUsd ?? existing.reserved_usd),
    serializeDetails(mergedDetails),
    id,
  ).run();
}

function mapRow(row: {
  id: string;
  source: SpendSource;
  et_date: string;
  at: string;
  actual_usd: number;
  estimated_usd: number;
  reserved_usd: number;
  details: string;
}): SpendLedgerRow {
  return {
    id: row.id,
    source: row.source,
    etDate: row.et_date,
    at: row.at,
    actualUsd: amount(row.actual_usd),
    estimatedUsd: amount(row.estimated_usd),
    reservedUsd: amount(row.reserved_usd),
    details: parseDetails(row.details),
  };
}

export async function readSpendLedger(
  env: Env,
  query: SpendLedgerQuery = {},
): Promise<SpendLedgerRow[]> {
  if (!hasDatabase(env)) return [];
  await ensureSpendLedger(env);
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (query.etDate) {
    clauses.push("et_date = ?");
    bindings.push(query.etDate);
  }
  if (query.source) {
    clauses.push("source = ?");
    bindings.push(query.source);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const statement = env.DB.prepare(
    `SELECT id, source, et_date, at, actual_usd, estimated_usd, reserved_usd, details
       FROM spend_pulls ${where} ORDER BY at DESC LIMIT ?`,
  ).bind(...bindings, limitValue(query.limit));
  const result = await statement.all<{
    id: string;
    source: SpendSource;
    et_date: string;
    at: string;
    actual_usd: number;
    estimated_usd: number;
    reserved_usd: number;
    details: string;
  }>();
  return (result.results ?? []).map(mapRow);
}

function emptyTotals(): SpendSourceTotals {
  return { actualUsd: 0, estimatedUsd: 0, reservedUsd: 0, pulls: 0, eventsFetched: 0 };
}

export async function readSpendTotals(env: Env, etDate: string): Promise<SpendTotals> {
  const sources: Record<SpendSource, SpendSourceTotals> = {
    seatdata: emptyTotals(),
    apify: emptyTotals(),
  };
  if (!hasDatabase(env)) return { etDate, sources, blended: emptyTotals() };
  await ensureSpendLedger(env);
  const result = await env.DB.prepare(
    `SELECT source,
            COALESCE(SUM(actual_usd), 0) AS actual_usd,
            COALESCE(SUM(estimated_usd), 0) AS estimated_usd,
            COALESCE(SUM(reserved_usd), 0) AS reserved_usd,
            COALESCE(SUM(COALESCE(json_extract(details, '$.pulls'), 1)), 0) AS pulls,
            COALESCE(SUM(CAST(json_extract(details, '$.eventsFetched') AS INTEGER)), 0) AS events_fetched
       FROM spend_pulls
      WHERE et_date = ?
      GROUP BY source`,
  ).bind(etDate).all<{
    source: SpendSource;
    actual_usd: number;
    estimated_usd: number;
    reserved_usd: number;
    pulls: number;
    events_fetched: number;
  }>();
  for (const row of result.results ?? []) {
    const total = sources[row.source];
    if (!total) continue;
    total.actualUsd = amount(row.actual_usd);
    total.estimatedUsd = amount(row.estimated_usd);
    total.reservedUsd = amount(row.reserved_usd);
    total.pulls = Math.max(0, Math.floor(Number(row.pulls) || 0));
    total.eventsFetched = Math.max(0, Math.floor(Number(row.events_fetched) || 0));
  }
  const blended = (Object.keys(sources) as SpendSource[]).reduce(
    (sum, source) => {
      const total = sources[source];
      sum.actualUsd += total.actualUsd;
      sum.estimatedUsd += total.estimatedUsd;
      sum.reservedUsd += total.reservedUsd;
      sum.pulls += total.pulls;
      sum.eventsFetched += total.eventsFetched;
      return sum;
    },
    emptyTotals(),
  );
  return { etDate, sources, blended };
}
