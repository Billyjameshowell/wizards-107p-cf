import { describe, expect, it, vi } from "vitest";
import { emptySpendState } from "../src/shared/guardrails";
import seed from "../data/seed-book.json";
vi.mock("../worker/store", () => ({
  loadLiveBook: vi.fn(async () => seed),
  readSpend: vi.fn(async () => emptySpendState("2026-09-15")),
  writeSpend: vi.fn(async () => {}),
  writeBookAndHistory: vi.fn(async () => {}),
}));
vi.mock("../worker/adapters/seatdata", () => ({ runSeatData: vi.fn() }));
vi.mock("../worker/adapters/apify", () => ({ runApify: vi.fn() }));
import { runIngest } from "../worker/ingest";
import { runSeatData } from "../worker/adapters/seatdata";
import { runApify } from "../worker/adapters/apify";
import { loadLiveBook, writeSpend, writeBookAndHistory } from "../worker/store";

function envWithLock(changes: number) {
  const release = vi.fn(async () => ({ meta: { changes: 1 } }));
  const acquire = vi.fn(async () => ({ meta: { changes } }));
  const env = {
    INGEST_ENABLED: "true", DRY_RUN: "false", SOURCES: "seatdata,apify",
    DB: { prepare: vi.fn((sql: string) => ({ bind: () => ({ run: sql.startsWith("DELETE") ? release : acquire }) })) },
  } as unknown as Env;
  return { env, release };
}

describe("ingest run serialization", () => {
  it("does not call sources or release someone else's lock when a run is active", async () => {
    vi.clearAllMocks();
    const { env, release } = envWithLock(0);
    const result = await runIngest(env, "http");
    expect(result.skippedReason).toBe("run_in_progress");
    expect(runSeatData).not.toHaveBeenCalled();
    expect(runApify).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it("records a safe source error, continues the other source, and releases the lock", async () => {
    vi.clearAllMocks();
    const { env, release } = envWithLock(1);
    vi.mocked(runSeatData).mockRejectedValue(new Error("secret credential must not leak"));
    vi.mocked(runApify).mockImplementation(async (_ctx, spend) => ({ spend, result: { source: "apify", paid: false, aborted: "missing_credential", points: [] } }));
    const result = await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"));
    expect(result.bookUpdated).toBe(false);
    expect(result.sources[0].aborted).toBe("request_failed");
    expect(JSON.stringify(result)).not.toContain("secret credential");
    expect(runApify).toHaveBeenCalledOnce();
    expect(writeSpend).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});


describe("record update timestamps", () => {
  it("timestamps only games refreshed by this run", async () => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    vi.mocked(runSeatData).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "seatdata", paid: true, points: [{ date: seed.games[0].date, advisedAsk: 123 }],
    } }));
    vi.mocked(runApify).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "apify", paid: false, points: [], aborted: "missing_credential",
    } }));
    await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"));
    const saved = vi.mocked(writeBookAndHistory).mock.calls[0][1];
    expect(saved.games[0].market_updated_at_et).toBe("2026-09-15 12:00pm");
    expect(saved.games[1].market_updated_at_et).toBeUndefined();
  });

  it("stores null metrics and preserves only a prior SeatData detail snapshot", async () => {
    vi.clearAllMocks();
    const priorDetails = {
      source: "seatdata" as const,
      asof: "2026-09-14 12:00pm",
      get_in: 180,
      median: 240,
      lower_level_get_in: 180,
      lower_level_median: 240,
      zone_get_in: 190,
      zone_median: 210,
      zone_comp_count: 2,
      zone_comps: [],
    };
    const currentBook = {
      ...seed,
      games: seed.games.map((game, index) => index === 0
        ? { ...game, market_details: priorDetails }
        : game),
    };
    vi.mocked(loadLiveBook).mockResolvedValueOnce(currentBook);
    const nextDetails = { ...priorDetails, asof: "2026-09-15 12:00pm", get_in: null, median: null };
    const { env } = envWithLock(1);
    vi.mocked(runSeatData).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "seatdata", paid: true,
      points: [{ date: seed.games[0].date, advisedAsk: null, marketDetails: nextDetails }],
    } }));
    vi.mocked(runApify).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "apify", paid: false, points: [], aborted: "missing_credential",
    } }));

    await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"));

    const saved = vi.mocked(writeBookAndHistory).mock.calls[0][1];
    const snapshots = vi.mocked(writeBookAndHistory).mock.calls[0][2];
    expect(saved.games[0].market_previous_details).toEqual(priorDetails);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      gameDate: seed.games[0].date,
      source: "seatdata",
      advisedAsk: null,
      getIn: null,
      median: null,
      listingCount: null,
    });
  });

  it("does not create snapshots for points outside the live book", async () => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    vi.mocked(runSeatData).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "seatdata", paid: true,
      points: [{ date: "2099-01-01", advisedAsk: 500 }],
    } }));
    vi.mocked(runApify).mockImplementation(async (_ctx, spend) => ({ spend, result: {
      source: "apify", paid: false, points: [], aborted: "missing_credential",
    } }));

    const result = await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"));

    expect(result.bookUpdated).toBe(false);
    expect(writeBookAndHistory).not.toHaveBeenCalled();
  });
});

describe("single-use seed orchestration", () => {
  it("passes seed caps only to authenticated HTTP orchestration and records progress", async () => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    vi.mocked(runSeatData).mockImplementation(async (_ctx, spend) => ({ spend, result: { source: "seatdata", paid: false, points: [] } }));
    vi.mocked(runApify).mockImplementation(async (_ctx, spend) => ({ spend, result: { source: "apify", paid: false, points: [] } }));
    await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"), true);
    expect(runSeatData).toHaveBeenCalledWith(expect.objectContaining({ seed: true }), expect.anything(), "2026-09-15");
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining("seed_20260915"));
    expect(writeSpend).toHaveBeenLastCalledWith(env, expect.objectContaining({ lastRun: expect.objectContaining({ seed: true }) }));
  });

  it("refuses a repeated seed without contacting providers", async () => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    vi.mocked(env.DB.prepare).mockImplementation((sql: string) => ({ bind: () => ({ run: async () => ({ meta: { changes: sql.includes("seed_20260915") ? 0 : 1 } }) }) }) as unknown as D1PreparedStatement);
    const result = await runIngest(env, "http", new Date("2026-09-15T16:00:00Z"), true);
    expect(result.skippedReason).toBe("seed_already_claimed");
    expect(runSeatData).not.toHaveBeenCalled();
    expect(runApify).not.toHaveBeenCalled();
  });

  it.each([["false", "false", "ingest_disabled"], ["true", "true", "dry_run"]])("keeps kill switches effective (%s/%s) without consuming seed", async (ingest, dryRun, reason) => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    const result = await runIngest({ ...env, INGEST_ENABLED: ingest, DRY_RUN: dryRun } as Env, "http", new Date(), true);
    expect(result.skippedReason).toBe(reason);
    expect(runSeatData).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalledWith(expect.stringContaining("seed_20260915"));
  });

  it("never elevates cron to seed mode", async () => {
    vi.clearAllMocks();
    const { env } = envWithLock(1);
    await runIngest(env, "cron", new Date(), true);
    expect(runSeatData).toHaveBeenCalledWith(expect.objectContaining({ seed: false }), expect.anything(), expect.anything());
    expect(env.DB.prepare).not.toHaveBeenCalledWith(expect.stringContaining("seed_20260915"));
  });
});
