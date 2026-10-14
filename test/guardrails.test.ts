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
  openCircuit,
  parseBooleanFlag,
  parseFlags,
  parseSources,
  recordPaidAttempt,
  recordSeatDataCharge,
  rolloverSpend,
  SEATDATA_DAILY_SPEND_CAP_USD,
  SEATDATA_PULL_USD,
  seatDataChargeUsd,
  seatDataDailyCostUsd,
  seatDataSlateFitsDailyCap,
  parseApifyActor,
  parseApifyBuild,
  parseApifyInputOverride,
  type AhmedSeatGeekInput,
  type LenticSeatGeekInput,
} from "@shared/guardrails";

const safeFlags = parseFlags({});

describe("SAFE defaults", () => {
  it("keeps ingest off and dry-run on when env is empty", () => {
    expect(safeFlags.ingestEnabled).toBe(false);
    expect(safeFlags.dryRun).toBe(true);
    expect(safeFlags.apifyIncludeListings).toBe(false);
    expect(safeFlags.seatdataFetchSales).toBe(false);
    expect(safeFlags.sources).toEqual(["seatdata"]);
    expect(safeFlags.seatdataMaxPullsPerRun).toBe(50);
    expect(safeFlags.seatdataMaxPullsPerEtDay).toBe(50);
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
    expect(parseSources("")).toEqual(["seatdata"]);
    expect(parseSources("seatdata,apify")).toEqual(["seatdata", "apify"]);
  });
});

describe("paid-call gates", () => {
  const live = parseFlags({ INGEST_ENABLED: "true", DRY_RUN: "false", SOURCES: "seatdata,apify" });

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

describe("SeatData pull caps", () => {
  it("stops at the run cap and the ET-day pull cap", () => {
    expect(HARD_CAPS.seatdataMaxPullsPerRun).toBe(50);
    expect(HARD_CAPS.seatdataMaxPullsPerEtDay).toBe(50);
    expect(
      canTakeSeatDataPull({
        runPulls: 50,
        pullsToday: 5,
        maxPerRun: 50,
        maxPerDay: 50,
      }),
    ).toEqual({ ok: false, reason: "run_pull_cap" });
    expect(
      canTakeSeatDataPull({
        runPulls: 4,
        pullsToday: 50,
        maxPerRun: 50,
        maxPerDay: 50,
      }),
    ).toEqual({ ok: false, reason: "day_pull_cap" });
    expect(
      canTakeSeatDataPull({
        runPulls: 49,
        pullsToday: 49,
        maxPerRun: 50,
        maxPerDay: 50,
      }).ok,
    ).toBe(true);
  });

  it("keeps a $2 ET-day spend cap at $0.04 per charged pull", () => {
    expect(SEATDATA_PULL_USD).toBe(0.04);
    expect(SEATDATA_DAILY_SPEND_CAP_USD).toBe(2);
    expect(seatDataChargeUsd(1)).toBe(0.04);
    expect(seatDataChargeUsd(true)).toBe(0.04);
    expect(seatDataChargeUsd(0)).toBe(0);
    expect(seatDataChargeUsd(false)).toBe(0);
    expect(seatDataDailyCostUsd(43)).toBe(1.72);
    expect(seatDataSlateFitsDailyCap(43)).toBe(true);
    expect(seatDataSlateFitsDailyCap(50)).toBe(true);
    expect(seatDataSlateFitsDailyCap(51)).toBe(false);

    expect(
      canTakeSeatDataPull({
        runPulls: 0,
        pullsToday: 49,
        maxPerRun: 50,
        maxPerDay: 50,
        usdToday: 1.96,
      }).ok,
    ).toBe(true);
    expect(
      canTakeSeatDataPull({
        runPulls: 0,
        pullsToday: 10,
        maxPerRun: 50,
        maxPerDay: 50,
        usdToday: 1.98,
      }),
    ).toEqual({ ok: false, reason: "day_spend_cap" });
    expect(
      canTakeSeatDataPull({
        runPulls: 0,
        pullsToday: 10,
        maxPerRun: 50,
        maxPerDay: 50,
        usdToday: 2,
      }),
    ).toEqual({ ok: false, reason: "day_spend_cap" });

    const charged = recordSeatDataCharge(emptySourceSpend(), "2026-09-11", 0.04);
    expect(charged.pullsToday).toBe(1);
    expect(charged.usdToday).toBe(0.04);
    const again = recordSeatDataCharge(charged, "2026-09-11", 0.04);
    expect(again.usdToday).toBe(0.08);
    const free = recordSeatDataCharge(again, "2026-09-11", 0);
    expect(free.pullsToday).toBe(2);
    expect(free.usdToday).toBe(0.08);
    const nextDay = recordSeatDataCharge(again, "2026-09-12", 0.04);
    expect(nextDay.pullsToday).toBe(1);
    expect(nextDay.usdToday).toBe(0.04);
  });

  it("counts pulls on the ET day and resets the next ET day", () => {
    const after = recordSeatDataCharge(emptySourceSpend(), "2026-09-11", 0.04);
    expect(after.pullsToday).toBe(1);
    expect(after.usdToday).toBe(0.04);
    const rolled = rolloverSpend(
      { etDate: "2026-09-11", sources: { seatdata: after, apify: emptySourceSpend() } },
      "2026-09-12",
    );
    expect(rolled.sources.seatdata.pullsToday).toBe(0);
    expect(rolled.sources.seatdata.usdToday).toBe(0);
    expect(rolled.sources.seatdata.circuitOpenEtDate).toBeNull();
    const sameDay = rolloverSpend(
      { etDate: "2026-09-11", sources: { seatdata: after, apify: emptySourceSpend() } },
      "2026-09-11",
    );
    expect(sameDay.sources.seatdata.usdToday).toBe(0.04);
  });
});

describe("Apify cheap-list defaults", () => {
  it("defaults to the SeatGeek API actor under the hard event cap", () => {
    const input = apifyActorInput(safeFlags) as AhmedSeatGeekInput;
    expect(safeFlags.apifyActor).toBe("ahmed_jasarevic~seatgeek-scraper");
    expect(input.performerSlugs).toEqual(["washington-wizards"]);
    expect(input.searchQueries).toEqual([]);
    expect(input.venueCity).toBe("Washington");
    expect(input.venueState).toBe("DC");
    expect(input.maxItems).toBe(50);
    const listingsOn = apifyActorInput(
      parseFlags({ APIFY_ACTOR: "lentic_clockss~seatgeek-scraper", APIFY_INCLUDE_LISTINGS: "true" }),
    ) as LenticSeatGeekInput;
    expect(listingsOn.includeListings).toBe(true);
    expect(listingsOn.maxResults).toBeLessThanOrEqual(50);
    expect(listingsOn.mode).toBe("performer");
  });

  it("lets APIFY_INPUT_JSON replace the filters but never the event cap", () => {
    const flags = parseFlags({
      APIFY_INPUT_JSON: JSON.stringify({
        searchQueries: ["Washington Wizards"],
        venueState: "DC",
        taxonomyIds: ["1030300"],
        maxItems: 5000,
        eventUrls: ["https://example.com/1"],
        onlyOpen: false,
        sort: "bogus",
      }),
    });
    const input = apifyActorInput(flags) as unknown as Record<string, unknown>;
    expect(input).toEqual({
      searchQueries: ["Washington Wizards"],
      venueState: "DC",
      taxonomyIds: ["1030300"],
      onlyOpen: false,
      maxItems: 50,
    });
    expect(parseApifyInputOverride("not json")).toBeNull();
    expect(parseApifyInputOverride("[1]")).toBeNull();
    expect(parseApifyInputOverride('{"maxItems":9}')).toBeNull();
    expect(parseApifyInputOverride(undefined)).toBeNull();
    expect(safeFlags.apifyInputOverride).toBeNull();
  });

  it("only accepts known actors and safe build tags", () => {
    expect(parseApifyActor(undefined)).toBe("ahmed_jasarevic~seatgeek-scraper");
    expect(parseApifyActor("someone~other-actor")).toBe("ahmed_jasarevic~seatgeek-scraper");
    expect(parseApifyActor("lentic_clockss/seatgeek-scraper")).toBe(
      "lentic_clockss~seatgeek-scraper",
    );
    expect(parseApifyBuild("0.1.72")).toBe("0.1.72");
    expect(parseApifyBuild("")).toBeNull();
    expect(parseApifyBuild("../../x?y")).toBeNull();
  });

  it("builds the legacy actor input under the same event cap", () => {
    const flags = parseFlags({ APIFY_ACTOR: "lentic_clockss~seatgeek-scraper", APIFY_MAX_EVENTS: "500" });
    const input = apifyActorInput(flags) as LenticSeatGeekInput;
    expect(input.performerSlug).toBe("washington-wizards");
    expect(input.maxResults).toBe(50);
    expect(input.maxPages).toBe(3);
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
