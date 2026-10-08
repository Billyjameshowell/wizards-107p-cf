import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  daysOutBasis,
  DEFAULT_ATTEND_VALUE,
  fitMarketModel,
  holdoutMedianAbsPercent,
  MIN_SNAPSHOTS,
  modelExplainer,
  NOT_ENOUGH_DATA,
  projectGame,
  saleProbability,
  storedModelFit,
  suggestListPrice,
  TRUST_OBSERVED_GAMES,
  TRUST_ROWS,
  type GameQuery,
  type MarketRow,
  type OpponentTier,
} from "@shared/price-model";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function gaussian(next: () => number): number {
  const u = Math.max(1e-12, next());
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type Truth = {
  intercept: number;
  days: number;
  curve1: number;
  curve2: number;
  marquee: number;
  soft: number;
  weekend: number;
  nationalTv: number;
  winRate: number;
  logSupply: number;
  game: Record<string, number>;
};

function trueLog(row: MarketRow, truth: Truth): number {
  const [days, curve1, curve2] = daysOutBasis(row.daysOut);
  return (
    truth.intercept +
    truth.days * days +
    truth.curve1 * curve1 +
    truth.curve2 * curve2 +
    (row.tier === "marquee" ? truth.marquee : 0) +
    (row.tier === "soft" ? truth.soft : 0) +
    (row.weekend ? truth.weekend : 0) +
    (row.nationalTv ? truth.nationalTv : 0) +
    truth.winRate * (row.winRate ?? 0.5) +
    truth.logSupply * Math.log(1 + (row.supply ?? 0)) +
    (truth.game[row.gameDate] ?? 0)
  );
}

function panel(noiseSd: number, seed = 7): { rows: MarketRow[]; truth: Truth } {
  const truth: Truth = {
    intercept: 5.15,
    days: 0.55,
    curve1: -0.8,
    curve2: 0.35,
    marquee: 0.22,
    soft: -0.16,
    weekend: 0.1,
    nationalTv: 0.14,
    winRate: 0.3,
    logSupply: -0.08,
    game: {},
  };
  const next = mulberry32(seed);
  const rows: MarketRow[] = [];
  for (let game = 0; game < 20; game += 1) {
    const gameDate = addDays("2027-01-01", game * 3);
    const tier: OpponentTier = game % 5 === 0 ? "marquee" : game % 5 === 1 ? "soft" : "standard";
    const weekend = game % 4 === 0;
    const nationalTv = game % 6 === 0;
    const winRate = 0.25 + (game % 5) * 0.12;
    const level = game === 0 ? 0.25 : game === 1 ? -0.2 : game === 2 ? 0.12 : 0;
    truth.game[gameDate] = level;
    for (let step = 0; step < 40; step += 1) {
      const daysOut = 5 + step * 2;
      const row: MarketRow = {
        gameDate,
        snapshotDate: addDays(gameDate, -daysOut),
        daysOut,
        median: 1,
        tier,
        weekend,
        nationalTv,
        winRate,
        supply: 4 + (step % 7),
      };
      const noisy = trueLog(row, truth) + gaussian(next) * noiseSd;
      row.median = Math.exp(noisy);
      rows.push(row);
    }
  }
  return { rows, truth };
}

function query(partial: Partial<GameQuery> & Pick<GameQuery, "gameDate" | "daysOut">): GameQuery {
  return {
    tier: "standard",
    weekend: false,
    nationalTv: false,
    winRate: 0.5,
    supply: 6,
    snapshots: 8,
    liveMedian: 180,
    attendValue: 0,
    ...partial,
  };
}

describe("fitMarketModel on a known curve", () => {
  const { rows, truth } = panel(0.02);

  it("recovers the shared path and the game levels", () => {
    expect(rows.length).toBeGreaterThanOrEqual(TRUST_ROWS);
    const fit = fitMarketModel(rows, "2026-10-08", { knots: [7, 21, 45, 90] });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.early).toBe(false);
    expect(fit.blend).toBe(1);
    expect(fit.version).toBe("1");
    expect(fit.terms).toContain("days");
    expect(fit.terms).toContain("marquee");
    expect(fit.terms).toContain("winRate");
    expect(fit.terms).toContain("logSupply");

    const sample = rows.filter((row) => row.tier === "standard" && !row.weekend && !row.nationalTv).slice(0, 30);
    const misses = sample.map((row) => {
      const projected = projectGame(fit, query({ gameDate: row.gameDate, daysOut: row.daysOut, liveMedian: null, winRate: row.winRate, supply: row.supply, tier: row.tier, weekend: row.weekend, nationalTv: row.nationalTv, snapshots: 40 }));
      const truthPrice = Math.exp(trueLog({ ...row, median: 1 }, truth));
      expect(projected.enough).toBe(true);
      expect(projected.todayLow!).toBeLessThanOrEqual(projected.todayPrice!);
      expect(projected.todayHigh!).toBeGreaterThanOrEqual(projected.todayPrice!);
      expect(projected.low!).toBeLessThanOrEqual(projected.price!);
      expect(projected.high!).toBeGreaterThanOrEqual(projected.price!);
      return Math.abs((projected.todayPrice ?? 0) - truthPrice) / truthPrice;
    });
    const typical = misses.slice().sort((a, b) => a - b)[Math.floor(misses.length / 2)] ?? 1;
    expect(typical).toBeLessThan(0.08);

    const far = projectGame(fit, query({ gameDate: "2027-01-07", daysOut: 50, liveMedian: null, snapshots: 40, winRate: 0.5, supply: 6 }));
    const near = projectGame(fit, query({ gameDate: "2027-01-07", daysOut: 5, liveMedian: null, snapshots: 40, winRate: 0.5, supply: 6 }));
    expect(far.todayPrice).not.toBeNull();
    expect(near.todayPrice).not.toBeNull();
    expect(far.todayPrice!).toBeGreaterThan(near.todayPrice!);

    const hot = "2027-01-01";
    const cold = "2027-01-04";
    const hotPrice = projectGame(fit, query({ gameDate: hot, daysOut: 30, liveMedian: null, snapshots: 40, tier: "marquee", weekend: true, nationalTv: true, winRate: 0.25, supply: 6 }));
    const coldPrice = projectGame(fit, query({ gameDate: cold, daysOut: 30, liveMedian: null, snapshots: 40, tier: "soft", weekend: false, nationalTv: false, winRate: 0.25, supply: 6 }));
    expect(hotPrice.todayPrice!).toBeGreaterThan(coldPrice.todayPrice!);
    expect(fit.intercepts[hot] ?? 0).toBeGreaterThan(fit.intercepts[cold] ?? 0);
  });

  it("scores the next check with a small median percent miss", () => {
    const miss = holdoutMedianAbsPercent(rows, "2026-10-08");
    expect(miss).not.toBeNull();
    expect(miss!).toBeLessThan(12);
  });

  it("stores an append-only fit record", () => {
    const fit = fitMarketModel(rows, "2026-10-08");
    const stored = storedModelFit({
      fit,
      holdoutMedianAbsPercent: 4.2,
      fittedAt: "2026-10-08T12:00:00.000Z",
      etDate: "2026-10-08",
      trigger: "cron",
    });
    expect(stored.version).toBe("1");
    expect(stored.early).toBe(0);
    expect(stored.holdoutMedianAbsPercent).toBe(4.2);
    const params = JSON.parse(stored.paramsJson) as { ok: boolean; terms: string[] };
    expect(params.ok).toBe(true);
    expect(params.terms.length).toBeGreaterThan(3);
  });
});

describe("gates, early blend, and the list suggestion", () => {
  it("says not enough data before five checks, and after tip", () => {
    const { rows } = panel(0.01, 3);
    const fit = fitMarketModel(rows, "2026-10-08");
    const thin = projectGame(fit, query({ gameDate: "2027-01-01", daysOut: 20, snapshots: MIN_SNAPSHOTS - 1 }));
    expect(thin.enough).toBe(false);
    expect(thin.price).toBeNull();
    expect(thin.sentence).toBe(NOT_ENOUGH_DATA);
    expect(thin.suggestion).toBeNull();

    const tipped = projectGame(fit, query({ gameDate: "2027-01-01", daysOut: -1, snapshots: 10 }));
    expect(tipped.sentence).toBe("This game has already tipped.");
    expect(MIN_SNAPSHOTS).toBe(5);
  });

  it("leans toward the live middle until the trust bar", () => {
    const rows: MarketRow[] = [];
    for (let game = 0; game < 4; game += 1) {
      const gameDate = addDays("2027-03-01", game * 7);
      for (let step = 0; step < 8; step += 1) {
        const daysOut = 10 + step * 4;
        rows.push({
          gameDate,
          snapshotDate: addDays(gameDate, -daysOut),
          daysOut,
          median: 150 + daysOut,
          tier: game === 0 ? "marquee" : "standard",
          weekend: game === 2,
          nationalTv: game === 3,
          winRate: 0.4 + game * 0.05,
          supply: 5 + step,
        });
      }
    }
    expect(rows.length).toBeLessThan(TRUST_ROWS);
    const fit = fitMarketModel(rows, "2026-10-08");
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.early).toBe(true);
    expect(fit.observedGames).toBe(0);
    expect(TRUST_OBSERVED_GAMES).toBe(22);
    const live = 240;
    const projected = projectGame(
      fit,
      query({ gameDate: "2027-03-01", daysOut: 18, snapshots: 8, liveMedian: live, tier: "marquee" }),
    );
    expect(projected.early).toBe(true);
    expect(projected.sentence.startsWith("Early estimate.")).toBe(true);
    expect(projected.todayPrice).not.toBeNull();
    expect(Math.abs((projected.todayPrice ?? 0) - live) / live).toBeLessThan(0.15);
  });

  it("uses a conservative sale curve and never lists", () => {
    const fair = 200;
    const atFair = saleProbability({ ask: fair, predictedMedian: fair, daysOut: 14, supply: 6 });
    const rich = saleProbability({ ask: fair * 1.25, predictedMedian: fair, daysOut: 14, supply: 6 });
    const crowded = saleProbability({ ask: fair, predictedMedian: fair, daysOut: 14, supply: 30 });
    const sooner = saleProbability({ ask: fair, predictedMedian: fair, daysOut: 2, supply: 6 });
    expect(rich).toBeLessThan(atFair);
    expect(crowded).toBeLessThan(atFair);
    expect(sooner).toBeLessThan(atFair);
    expect(atFair).toBeGreaterThan(0.05);
    expect(atFair).toBeLessThan(0.6);

    const suggestion = suggestListPrice({ predictedMedian: fair, daysOut: 14, supply: 6, attendValue: DEFAULT_ATTEND_VALUE });
    expect(suggestion.hold).toBe(false);
    expect(suggestion.ask).not.toBeNull();
    expect(suggestion.sentence).toMatch(/Nothing is listed for you/);
    expect(suggestion).not.toHaveProperty("listed");

    const chosen = suggestion.ask ?? 0;
    const chosenNet =
      saleProbability({ ask: chosen, predictedMedian: fair, daysOut: 14, supply: 6 }) * chosen * 2 * 0.95;
    const worseAsk = Math.round(fair * 1.3);
    const worseNet =
      saleProbability({ ask: worseAsk, predictedMedian: fair, daysOut: 14, supply: 6 }) * worseAsk * 2 * 0.95;
    expect(chosenNet).toBeGreaterThanOrEqual(worseNet - 0.01);

    const stay = suggestListPrice({ predictedMedian: fair, daysOut: 14, supply: 6, attendValue: 10_000 });
    expect(stay.hold).toBe(true);
    expect(stay.ask).toBeNull();
    expect(stay.sentence).toMatch(/Nothing is listed for you/);
  });

  it("explains the model without technical jargon", () => {
    const note = modelExplainer();
    expect(note).toMatch(/early estimate/i);
    expect(note).toMatch(/five checks/);
    expect(note).toMatch(/Nothing is listed for you/);
    expect(note).not.toMatch(/regression|spline|logit|logistic|bayes|hierarchical|coefficient|prior|empirical/i);
  });

  it("refits from the cron path and only inserts fit rows", () => {
    const ingest = readFileSync(new URL("../worker/ingest.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../worker/model-fit.ts", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../migrations/0004_price_model.sql", import.meta.url), "utf8");
    expect(ingest).toContain("refitPriceModel");
    expect(store).toContain("INSERT INTO price_model_fits");
    expect(store).not.toMatch(/UPDATE price_model_fits|DELETE FROM price_model_fits/i);
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS price_model_fits");
    expect(migration).not.toMatch(/UPDATE |DELETE /i);
  });
});
