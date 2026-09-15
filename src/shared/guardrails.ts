export type SourceId = "seatdata" | "apify";

export const HARD_CAPS = {
  seatdataMaxPullsPerRun: 20,
  seatdataMaxPullsPerEtDay: 25,
  apifyMaxTotalChargeUsd: 0.5,
  apifyMaxEvents: 50,
  paidAttemptsPerSourcePerRun: 1,
} as const;

export const DEFAULT_SOURCES: SourceId[] = ["seatdata", "apify"];

/** Returns true only for a non-empty credential that is not an obvious placeholder. */
export function isUsableCredential(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return ![
    "change-me",
    "change-me-local-only",
    "changeme",
    "dummy",
    "example",
    "placeholder",
    "not_configured",
    "ingest_disabled",
    "replace-me",
    "replace_with_real_key",
    "your-api-key",
    "your_api_key",
    "your-token",
    "your_token",
  ].some((marker) => normalized === marker || normalized.includes(marker));
}

export type Flags = {
  ingestEnabled: boolean;
  dryRun: boolean;
  sources: SourceId[];
  apifyIncludeListings: boolean;
  seatdataMaxPullsPerRun: number;
  seatdataMaxPullsPerEtDay: number;
  apifyMaxTotalChargeUsd: number;
  apifyMaxEvents: number;
  seatdataBaseUrl: string;
};

export type SourceSpend = {
  paidAttemptsToday: number;
  lastAttemptEtDate: string | null;
  pullsToday: number;
  lastPullEtDate: string | null;
  circuitOpenEtDate: string | null;
  /** Last event date selected by the SeatData baseline rotation. */
  rotationCursor?: string | null;
  lastError?: string;
};

export type SpendState = {
  etDate: string;
  sources: Record<SourceId, SourceSpend>;
  lastRun?: {
    at: string;
    trigger: "cron" | "http";
    ingestEnabled: boolean;
    dryRun: boolean;
    skippedReason?: string;
    bookUpdated?: boolean;
    seed?: boolean;
    sources: Record<
      string,
      {
        attempted: boolean;
        paid: boolean;
        aborted?: string;
        pulls?: number;
        spend?: { actualUsd: number; estimatedUsd: number; reservedUsd: number; eventsFetched: number; pulls: number; runId?: string; status?: string; stats?: unknown };
      }
    >;
  };
};

export type Decision = { ok: true } | { ok: false; reason: string };

export function emptySourceSpend(): SourceSpend {
  return {
    paidAttemptsToday: 0,
    lastAttemptEtDate: null,
    pullsToday: 0,
    lastPullEtDate: null,
    circuitOpenEtDate: null,
    rotationCursor: null,
  };
}

export function emptySpendState(etDate: string): SpendState {
  return {
    etDate,
    sources: {
      seatdata: emptySourceSpend(),
      apify: emptySourceSpend(),
    },
  };
}

export function parseBooleanFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function parseSources(value: string | undefined): SourceId[] {
  const raw = (value ?? DEFAULT_SOURCES.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowed: SourceId[] = ["seatdata", "apify"];
  const next = raw.filter((item): item is SourceId =>
    allowed.includes(item as SourceId),
  );
  return next.length > 0 ? next : [...DEFAULT_SOURCES];
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Env may lower a cap, never raise it past the hard default. */
export function clampCap(requested: number, hardMax: number): number {
  return Math.min(Math.max(0.0001, requested), hardMax);
}

function readEnvString(env: object, key: string): string | undefined {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function parseFlags(env: object): Flags {
  return {
    ingestEnabled: parseBooleanFlag(readEnvString(env, "INGEST_ENABLED"), false),
    dryRun: parseBooleanFlag(readEnvString(env, "DRY_RUN"), true),
    sources: parseSources(readEnvString(env, "SOURCES")),
    apifyIncludeListings: parseBooleanFlag(readEnvString(env, "APIFY_INCLUDE_LISTINGS"), false),
    seatdataMaxPullsPerRun: Math.round(
      clampCap(
        parsePositiveNumber(
          readEnvString(env, "SEATDATA_MAX_PULLS_PER_RUN"),
          HARD_CAPS.seatdataMaxPullsPerRun,
        ),
        HARD_CAPS.seatdataMaxPullsPerRun,
      ),
    ),
    seatdataMaxPullsPerEtDay: Math.round(
      clampCap(
        parsePositiveNumber(
          readEnvString(env, "SEATDATA_MAX_PULLS_PER_ET_DAY"),
          HARD_CAPS.seatdataMaxPullsPerEtDay,
        ),
        HARD_CAPS.seatdataMaxPullsPerEtDay,
      ),
    ),
    apifyMaxTotalChargeUsd: clampCap(
      parsePositiveNumber(
        readEnvString(env, "APIFY_MAX_TOTAL_CHARGE_USD"),
        HARD_CAPS.apifyMaxTotalChargeUsd,
      ),
      HARD_CAPS.apifyMaxTotalChargeUsd,
    ),
    apifyMaxEvents: Math.round(
      clampCap(
        parsePositiveNumber(readEnvString(env, "APIFY_MAX_EVENTS"), HARD_CAPS.apifyMaxEvents),
        HARD_CAPS.apifyMaxEvents,
      ),
    ),
    seatdataBaseUrl: (readEnvString(env, "SEATDATA_BASE_URL") ?? "https://seatdata.io/api").replace(
      /\/$/,
      "",
    ),
  };
}

export function etDateFrom(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function rolloverSpend(state: SpendState | null | undefined, etDate: string): SpendState {
  const base = state ?? emptySpendState(etDate);
  const next = emptySpendState(etDate);
  for (const source of Object.keys(next.sources) as SourceId[]) {
    const prev = base.sources[source] ?? emptySourceSpend();
    const sameDay = prev.lastPullEtDate === etDate || prev.lastAttemptEtDate === etDate;
    next.sources[source] = {
      paidAttemptsToday: sameDay && prev.lastAttemptEtDate === etDate ? prev.paidAttemptsToday : 0,
      lastAttemptEtDate: prev.lastAttemptEtDate === etDate ? prev.lastAttemptEtDate : null,
      pullsToday: sameDay && prev.lastPullEtDate === etDate ? prev.pullsToday : 0,
      lastPullEtDate: prev.lastPullEtDate === etDate ? prev.lastPullEtDate : null,
      circuitOpenEtDate: prev.circuitOpenEtDate === etDate ? etDate : null,
      rotationCursor: prev.rotationCursor ?? null,
      lastError: prev.circuitOpenEtDate === etDate ? prev.lastError : undefined,
    };
  }
  next.lastRun = base.lastRun;
  return next;
}

export function isCircuitOpen(spend: SourceSpend, etDate: string): boolean {
  return spend.circuitOpenEtDate === etDate;
}

export function isAbortHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function canStartPaidSource(args: {
  flags: Flags;
  source: SourceId;
  runPaidAttempts: number;
  spend: SourceSpend;
  etDate: string;
  hasCredential: boolean;
}): Decision {
  if (!args.flags.ingestEnabled) {
    return { ok: false, reason: "ingest_disabled" };
  }
  if (args.flags.dryRun) {
    return { ok: false, reason: "dry_run" };
  }
  if (!args.flags.sources.includes(args.source)) {
    return { ok: false, reason: "source_off" };
  }
  if (!args.hasCredential) {
    return { ok: false, reason: "missing_credential" };
  }
  if (isCircuitOpen(args.spend, args.etDate)) {
    return { ok: false, reason: "circuit_open" };
  }
  if (args.runPaidAttempts >= HARD_CAPS.paidAttemptsPerSourcePerRun) {
    return { ok: false, reason: "already_attempted_this_run" };
  }
  return { ok: true };
}

export function canTakeSeatDataPull(args: {
  runPulls: number;
  pullsToday: number;
  maxPerRun: number;
  maxPerDay: number;
}): Decision {
  if (args.runPulls >= args.maxPerRun) {
    return { ok: false, reason: "run_pull_cap" };
  }
  if (args.pullsToday >= args.maxPerDay) {
    return { ok: false, reason: "day_pull_cap" };
  }
  return { ok: true };
}

export function apifyActorInput(flags: Flags): {
  mode: "performer";
  performerSlug: string;
  maxResults: number;
  maxPages: number;
  includeListings: boolean;
  enrichDetails: boolean;
} {
  return {
    mode: "performer",
    performerSlug: "washington-wizards",
    maxResults: flags.apifyMaxEvents,
    maxPages: 2,
    includeListings: flags.apifyIncludeListings === true,
    enrichDetails: false,
  };
}

export function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i += 1) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

export function authorizeBearer(
  header: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || secret.trim() === "") return false;
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(header, expected);
}

export function openCircuit(spend: SourceSpend, etDate: string, error: string): SourceSpend {
  return {
    ...spend,
    circuitOpenEtDate: etDate,
    lastError: error,
  };
}

export function recordPaidAttempt(spend: SourceSpend, etDate: string): SourceSpend {
  const sameDay = spend.lastAttemptEtDate === etDate;
  return {
    ...spend,
    paidAttemptsToday: (sameDay ? spend.paidAttemptsToday : 0) + 1,
    lastAttemptEtDate: etDate,
  };
}

export function recordSeatDataPull(spend: SourceSpend, etDate: string): SourceSpend {
  const sameDay = spend.lastPullEtDate === etDate;
  return {
    ...spend,
    pullsToday: (sameDay ? spend.pullsToday : 0) + 1,
    lastPullEtDate: etDate,
  };
}
