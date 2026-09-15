import { describe, expect, it } from "vitest";
import {
  HARD_CAPS,
  apifyActorInput,
  authorizeBearer,
  canStartPaidSource,
  canTakeSeatDataPull,
  clampCap,
  emptySourceSpend,
  emptySpendState,
  etDateFrom,
  isAbortHttpStatus,
  isCircuitOpen,
  isUsableCredential,
  openCircuit,
  parseBooleanFlag,
  parseFlags,
  parseSources,
  recordPaidAttempt,
  recordSeatDataPull,
  rolloverSpend,
} from "@shared/guardrails";

const safeFlags = parseFlags({});

describe("SAFE defaults", () => {
  it("keeps ingest off and dry-run on when env is empty", () => {
    expect(safeFlags.ingestEnabled).toBe(false);
    expect(safeFlags.dryRun).toBe(true);
    expect(safeFlags.apifyIncludeListings).toBe(false);
    expect(safeFlags.sources).toEqual(["seatdata", "apify"]);
    expect(safeFlags.seatdataMaxPullsPerRun).toBe(20);
    expect(safeFlags.seatdataMaxPullsPerEtDay).toBe(25);
    expect(safeFlags.apifyMaxTotalChargeUsd).toBe(0.5);
    expect(safeFlags.apifyMaxEvents).toBe(50);
  });

  it("does not treat unknown flag strings as enabling spend", () => {
    expect(parseBooleanFlag("maybe", false)).toBe(false);
    expect(parseBooleanFlag("YES", false)).toBe(true);
    expect(parseBooleanFlag("off", true)).toBe(false);
  });

  it("never raises caps past hard defaults", () => {
    const flags = parseFlags({
      SEATDATA_MAX_PULLS_PER_RUN: "200",
      SEATDATA_MAX_PULLS_PER_ET_DAY: "999",
      APIFY_MAX_TOTAL_CHARGE_USD: "25",
      APIFY_MAX_EVENTS: "500",
    });
    expect(flags.seatdataMaxPullsPerRun).toBe(HARD_CAPS.seatdataMaxPullsPerRun);
    expect(flags.seatdataMaxPullsPerEtDay).toBe(HARD_CAPS.seatdataMaxPullsPerEtDay);
    expect(flags.apifyMaxTotalChargeUsd).toBe(HARD_CAPS.apifyMaxTotalChargeUsd);
    expect(flags.apifyMaxEvents).toBe(HARD_CAPS.apifyMaxEvents);
    expect(clampCap(99, 20)).toBe(20);
  });

  it("parses source lists and ignores unknown names", () => {
    expect(parseSources("seatdata")).toEqual(["seatdata"]);
    expect(parseSources("apify,ticketdata")).toEqual(["apify"]);
    expect(parseSources("")).toEqual(["seatdata", "apify"]);
  });
});

describe("paid-call gates", () => {
  const live = parseFlags({ INGEST_ENABLED: "true", DRY_RUN: "false" });

  it("blocks paid work when ingest is off or dry-run is on", () => {
    expect(
      canStartPaidSource({
        flags: safeFlags,
        source: "seatdata",
        runPaidAttempts: 0,
        spend: emptySourceSpend(),
        etDate: "2026-09-11",
        hasCredential: true,
      }),
    ).toEqual({ ok: false, reason: "ingest_disabled" });

    expect(
      canStartPaidSource({
        flags: parseFlags({ INGEST_ENABLED: "true", DRY_RUN: "true" }),
        source: "apify",
        runPaidAttempts: 0,
        spend: emptySourceSpend(),
        etDate: "2026-09-11",
        hasCredential: true,
      }),
    ).toEqual({ ok: false, reason: "dry_run" });
  });

  it("allows only one paid attempt per source per run", () => {
    const first = canStartPaidSource({
      flags: live,
      source: "seatdata",
      runPaidAttempts: 0,
      spend: emptySourceSpend(),
      etDate: "2026-09-11",
      hasCredential: true,
    });
    expect(first.ok).toBe(true);
    expect(
      canStartPaidSource({
        flags: live,
        source: "seatdata",
        runPaidAttempts: 1,
        spend: emptySourceSpend(),
        etDate: "2026-09-11",
        hasCredential: true,
      }),
    ).toEqual({ ok: false, reason: "already_attempted_this_run" });
  });

  it("requires credentials and respects an ET-day circuit breaker", () => {
    expect(
      canStartPaidSource({
        flags: live,
        source: "apify",
        runPaidAttempts: 0,
        spend: emptySourceSpend(),
        etDate: "2026-09-11",
        hasCredential: false,
      }),
    ).toEqual({ ok: false, reason: "missing_credential" });

    const tripped = openCircuit(emptySourceSpend(), "2026-09-11", "http_429");
    expect(isCircuitOpen(tripped, "2026-09-11")).toBe(true);
    expect(
      canStartPaidSource({
        flags: live,
        source: "apify",
        runPaidAttempts: 0,
        spend: tripped,
        etDate: "2026-09-11",
        hasCredential: true,
      }),
    ).toEqual({ ok: false, reason: "circuit_open" });
  });

  it("aborts a source on 429 and 5xx", () => {
    expect(isAbortHttpStatus(429)).toBe(true);
    expect(isAbortHttpStatus(503)).toBe(true);
    expect(isAbortHttpStatus(200)).toBe(false);
    expect(isAbortHttpStatus(404)).toBe(false);
  });
});

describe("credential readiness", () => {
  it("rejects empty and obvious placeholder credentials", () => {
    expect(isUsableCredential(undefined)).toBe(false);
    expect(isUsableCredential("  ")).toBe(false);
    expect(isUsableCredential("change-me-local-only")).toBe(false);
    expect(isUsableCredential("your-api-key")).toBe(false);
    expect(isUsableCredential("real-token-value")).toBe(true);
  });
});

describe("SeatData pull caps", () => {
  it("stops at 20 pulls per run and 25 per ET day", () => {
    expect(
      canTakeSeatDataPull({
        runPulls: 20,
        pullsToday: 5,
        maxPerRun: 20,
        maxPerDay: 25,
      }),
    ).toEqual({ ok: false, reason: "run_pull_cap" });
    expect(
      canTakeSeatDataPull({
        runPulls: 4,
        pullsToday: 25,
        maxPerRun: 20,
        maxPerDay: 25,
      }),
    ).toEqual({ ok: false, reason: "day_pull_cap" });
    expect(
      canTakeSeatDataPull({
        runPulls: 19,
        pullsToday: 24,
        maxPerRun: 20,
        maxPerDay: 25,
      }).ok,
    ).toBe(true);
  });

  it("counts pulls on the ET day and resets the next ET day", () => {
    const after = recordSeatDataPull(emptySourceSpend(), "2026-09-11");
    expect(after.pullsToday).toBe(1);
    const rolled = rolloverSpend(
      { etDate: "2026-09-11", sources: { seatdata: after, apify: emptySourceSpend() } },
      "2026-09-12",
    );
    expect(rolled.sources.seatdata.pullsToday).toBe(0);
    expect(rolled.sources.seatdata.circuitOpenEtDate).toBeNull();
  });
});

describe("Apify cheap-list defaults", () => {
  it("keeps listings off and charge/event caps at the hard ceiling", () => {
    const input = apifyActorInput(safeFlags);
    expect(input.includeListings).toBe(false);
    expect(input.maxResults).toBe(50);
    expect(input.maxPages).toBe(2);
    expect(input.mode).toBe("performer");
    expect(input.performerSlug).toBe("washington-wizards");
    const listingsOn = apifyActorInput(
      parseFlags({ APIFY_INCLUDE_LISTINGS: "true" }),
    );
    expect(listingsOn.includeListings).toBe(true);
    expect(listingsOn.maxResults).toBeLessThanOrEqual(50);
  });
});

describe("cron bearer auth", () => {
  it("fails closed without a secret and requires Bearer CRON_SECRET", () => {
    expect(authorizeBearer("Bearer secret", undefined)).toBe(false);
    expect(authorizeBearer("Bearer secret", "")).toBe(false);
    expect(authorizeBearer(null, "secret")).toBe(false);
    expect(authorizeBearer("Bearer other", "secret")).toBe(false);
    expect(authorizeBearer("Bearer secret", "secret")).toBe(true);
    expect(authorizeBearer("secret", "secret")).toBe(false);
  });
});

describe("ET calendar", () => {
  it("uses America/New_York dates for the morning job", () => {
    const utcNoon = new Date("2026-09-11T12:00:00.000Z");
    expect(etDateFrom(utcNoon)).toBe("2026-09-11");
    const lateUtc = new Date("2026-09-12T02:00:00.000Z");
    expect(etDateFrom(lateUtc)).toBe("2026-09-11");
  });

  it("records a paid attempt once per source", () => {
    const once = recordPaidAttempt(emptySourceSpend(), "2026-09-11");
    const twice = recordPaidAttempt(once, "2026-09-11");
    expect(twice.paidAttemptsToday).toBe(2);
  });
});

describe("empty spend", () => {
  it("starts with both sources closed-circuit-free", () => {
    const spend = emptySpendState("2026-09-11");
    expect(spend.sources.seatdata.circuitOpenEtDate).toBeNull();
    expect(spend.sources.apify.pullsToday).toBe(0);
  });
});

it("rejects the deployed disabled credential placeholder", () => {
  expect(isUsableCredential("NOT_CONFIGURED_INGEST_DISABLED")).toBe(false);
});
