import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInstantOffer } from "@shared/instant-offer";
import {
  askOffers,
  calibrateSaleCurve,
  daysOutBasis,
  detectLikelySales,
  fitMarketModel,
  holdoutMedianAbsPercent,
  keepingSentence,
  LIKELY_SOLD_MIN_DAYS,
  modelExplainer,
  NOT_ENOUGH_DATA,
  offersNearTip,
  opponentTier,
  planSeason,
  projectGame,
  SALE_PRIORS,
  saleOutcomeRows,
  saleProbability,
  storedModelFit,
  suggestListPrice,
  TRUST_OBSERVED_GAMES,
  TRUST_ROWS,
  withKeeping,
  type AskOffer,
  type CompSnap,
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
    liveMedian: 180,
    ...partial,
  };
}

function offer(ask: number, chance: number): AskOffer {
  const pair = Math.round(ask * 2 * 0.95 * 100) / 100;
  return { ask, chance, pair, expected: Math.round(chance * pair * 100) / 100 };
}

function snap(partial: Partial<CompSnap> & Pick<CompSnap, "etDate" | "daysOut" | "price">): CompSnap {
  return {
    gameDate: "2026-12-01",
    pulledAt: `${partial.etDate}T16:00:00.000Z`,
    section: "107",
    row: "P",
    quantity: 2,
    supply: 4,
    median: 190,
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
      const projected = projectGame(fit, query({ gameDate: row.gameDate, daysOut: row.daysOut, liveMedian: null, winRate: row.winRate, supply: row.supply, tier: row.tier, weekend: row.weekend, nationalTv: row.nationalTv }));
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

    const far = projectGame(fit, query({ gameDate: "2027-01-07", daysOut: 50, liveMedian: null, winRate: 0.5, supply: 6 }));
    const near = projectGame(fit, query({ gameDate: "2027-01-07", daysOut: 5, liveMedian: null, winRate: 0.5, supply: 6 }));
    expect(far.todayPrice).not.toBeNull();
    expect(near.todayPrice).not.toBeNull();
    expect(far.todayPrice!).toBeGreaterThan(near.todayPrice!);

    const hot = "2027-01-01";
    const cold = "2027-01-04";
    const hotPrice = projectGame(fit, query({ gameDate: hot, daysOut: 30, liveMedian: null, tier: "marquee", weekend: true, nationalTv: true, winRate: 0.25, supply: 6 }));
    const coldPrice = projectGame(fit, query({ gameDate: cold, daysOut: 30, liveMedian: null, tier: "soft", weekend: false, nationalTv: false, winRate: 0.25, supply: 6 }));
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
  it("prices a game with no listings from similar games, says so, and says nothing after tip", () => {
    const { rows } = panel(0.01, 3);
    const fit = fitMarketModel(rows, "2026-10-08");
    const unlisted = projectGame(fit, query({ gameDate: "2027-05-01", daysOut: 20, liveMedian: null }));
    expect(unlisted.enough).toBe(true);
    expect(unlisted.todayPrice).not.toBeNull();
    expect(unlisted.sentence).toMatch(/No similar seats are listed for this game yet/);
    expect(unlisted.suggestion?.ask).not.toBeNull();

    const tipped = projectGame(fit, query({ gameDate: "2027-01-01", daysOut: -1 }));
    expect(tipped.sentence).toBe("");
    expect(projectGame({ ok: false, version: "1", rows: 0, games: 0, observedGames: 0, reason: "x" }, query({ gameDate: "2027-01-01", daysOut: 5 })).sentence).toBe(NOT_ENOUGH_DATA);
  });

  it("anchors today on the live middle and only uses the fit for the path to tip", () => {
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
      query({ gameDate: "2027-03-01", daysOut: 18, liveMedian: live, tier: "marquee" }),
    );
    expect(projected.early).toBe(true);
    expect(projected.early).toBe(true);
    expect(projected.sentence).not.toMatch(/Early estimate/);
    expect(projected.todayPrice).not.toBeNull();
    expect(projected.todayPrice).toBe(live);
    // These games get pricier further out, so the tip price is under today's.
    expect(projected.price!).toBeLessThan(live);
  });

  it("uses a sale curve that falls as the ask rises, never saturates, and never lists", () => {
    const fair = 200;
    const atFair = saleProbability({ ask: fair, predictedMedian: fair, daysOut: 14 });
    const cheap = saleProbability({ ask: fair * 0.7, predictedMedian: fair, daysOut: 14 });
    const rich = saleProbability({ ask: fair * 1.25, predictedMedian: fair, daysOut: 14 });
    const sooner = saleProbability({ ask: fair, predictedMedian: fair, daysOut: 2 });
    const giveaway = saleProbability({ ask: 1, predictedMedian: fair, daysOut: 60 });
    expect(cheap).toBeGreaterThan(atFair);
    expect(rich).toBeLessThan(atFair);
    expect(sooner).toBeLessThan(atFair);
    expect(atFair).toBeGreaterThan(0.4);
    expect(atFair).toBeLessThan(0.9);
    expect(giveaway).toBeLessThanOrEqual(0.95);

    const offers = askOffers({ predictedMedian: fair, daysOut: 14 });
    for (let index = 1; index < offers.length; index += 1) {
      expect(offers[index]!.ask).toBeGreaterThan(offers[index - 1]!.ask);
      expect(offers[index]!.chance).toBeLessThan(offers[index - 1]!.chance);
    }
    expect(new Set(offers.map((row) => row.chance)).size).toBe(offers.length);

    const suggestion = suggestListPrice({ predictedMedian: fair, daysOut: 14 });
    expect(suggestion.hold).toBe(false);
    expect(suggestion.ask).not.toBeNull();
    expect(suggestion.sentence).not.toMatch(/Nothing is listed/);
    expect(suggestion).not.toHaveProperty("listed");
    expect(suggestion).not.toHaveProperty("attendValue");

    const chosen = offers.find((row) => row.ask === suggestion.ask);
    expect(chosen).toBeTruthy();
    for (const row of offers) {
      expect(chosen?.expected ?? 0).toBeGreaterThanOrEqual(row.expected - 0.01);
    }
    // The best ask is interior, not an edge of the 70-150% ladder.
    expect(chosen?.ask).toBeGreaterThan(offers[0]!.ask);
    expect(chosen?.ask).toBeLessThan(offers[offers.length - 1]!.ask);
  });

  it("leans toward a safer ask when the season goal is out of reach, and holds out when cash is already in", () => {
    // Most expected cash is 60. 100 and 45 also clear the lean's cash floor but sit
    // outside the ±10% band, so the lean never jumps to them.
    const offers = [
      offer(100, 0.5),
      offer(66, 0.8),
      offer(63, 0.85),
      offer(60, 0.9),
      offer(57, 0.93),
      offer(54, 0.95),
      offer(45, 0.99),
    ];
    const game = { date: "2026-12-01", opponent: "Knicks", keeping: false, sold: false, banked: 0, offers };
    const poor = planSeason([game], { breakEven: 6000, cushion: 0.15 });
    const rich = planSeason(
      [{ date: "2026-11-01", opponent: "Sold", keeping: false, sold: true, banked: 20000, offers: [] }, game],
      { breakEven: 6000, cushion: 0.15 },
    );
    expect(poor.lean).toBe("safer");
    expect(rich.lean).toBe("patient");
    expect(poor.target).toBe(6900);
    expect(poor.asks["2026-12-01"]?.ask).toBeLessThan(rich.asks["2026-12-01"]?.ask ?? 0);
    expect(poor.asks["2026-12-01"]?.ask).toBe(54);
    expect(rich.asks["2026-12-01"]?.ask).toBe(66);
    expect(poor.asks["2026-12-01"]?.chance).toBeGreaterThan(rich.asks["2026-12-01"]?.chance ?? 1);
    expect(poor.sentence).not.toMatch(/Nothing is listed/);
    expect(rich.banked).toBe(20000);
    expect(rich.chance).toBe(1);
  });

  it("shows that marking a game Sit lowers expected cash and the chance of the goal", () => {
    const offers = [offer(80, 0.9)];
    const games = [
      { date: "2026-12-01", opponent: "Knicks", keeping: false, sold: false, banked: 0, offers },
      { date: "2026-12-08", opponent: "Nets", keeping: false, sold: false, banked: 0, offers },
    ];
    const both = planSeason(games, { breakEven: 100, cushion: 0 });
    const kept = planSeason(withKeeping(games, "2026-12-01", true), { breakEven: 100, cushion: 0 });
    expect(kept.expectedTotal).toBeLessThan(both.expectedTotal);
    expect(kept.chance).toBeLessThan(both.chance);
    expect(kept.kept).toBe(1);
    const note = keepingSentence(both, kept, false);
    expect(note).toMatch(/If you sit instead, season cash goes from/);
    expect(note).not.toMatch(/Nothing is listed/);
  });

  it("treats a pair that vanishes well before tip as a possible sale, and ignores edits and singles", () => {
    const sold = detectLikelySales([
      snap({ etDate: "2026-10-01", daysOut: 61, price: 200 }),
      snap({ etDate: "2026-10-08", daysOut: 54, price: 260 }),
    ]);
    expect(sold).toHaveLength(1);
    expect(sold[0]?.certain).toBe(false);
    expect(sold[0]?.daysOut).toBeGreaterThan(LIKELY_SOLD_MIN_DAYS);

    const edited = detectLikelySales([
      snap({ etDate: "2026-10-01", daysOut: 61, price: 200 }),
      snap({ etDate: "2026-10-08", daysOut: 54, price: 210 }),
    ]);
    expect(edited).toHaveLength(0);

    const nearTip = detectLikelySales([
      snap({ etDate: "2026-11-27", daysOut: 4, price: 200 }),
      snap({ etDate: "2026-11-29", daysOut: 2, price: 260 }),
    ]);
    expect(nearTip).toHaveLength(0);

    const single = detectLikelySales([
      snap({ etDate: "2026-10-01", daysOut: 61, price: 40, quantity: 1 }),
      snap({ etDate: "2026-10-08", daysOut: 54, price: 260 }),
    ]);
    expect(single).toHaveLength(0);
  });

  it("labels a played game's pair sold when its seats are gone from the last check before tip", () => {
    const rows = saleOutcomeRows(
      [
        snap({ etDate: "2026-11-20", daysOut: 11, price: 150, row: "K" }),
        snap({ etDate: "2026-11-20", daysOut: 11, price: 300, row: "M" }),
        // A later pull the same day is ignored.
        snap({ etDate: "2026-11-20", pulledAt: "2026-11-20T22:00:00.000Z", daysOut: 11, price: 999, row: "Q" }),
        snap({ etDate: "2026-11-30", daysOut: 1, price: 280, row: "M" }),
        // An upcoming game is left out.
        snap({ gameDate: "2026-12-20", etDate: "2026-11-20", daysOut: 30, price: 100, row: "K" }),
      ],
      "2026-12-05",
    );
    expect(rows).toEqual([
      { sold: true, ratio: 150 / 190, daysOut: 11 },
      { sold: false, ratio: 300 / 190, daysOut: 11 },
    ]);
  });

  it("keeps the set sale curve until both outcomes are thick, then lets played games move its level", () => {
    const thin = calibrateSaleCurve([{ sold: true, ratio: 1, daysOut: 10 }]);
    expect(thin).toEqual(SALE_PRIORS);

    const rows = Array.from({ length: 600 }, (_, index) => ({
      sold: index % 10 < 8,
      ratio: 0.8 + (index % 7) * 0.1,
      daysOut: index % 15,
    }));
    const curve = calibrateSaleCurve(rows);
    expect(curve.intercept).not.toBe(SALE_PRIORS.intercept);
    expect(curve.logRatio).toBe(SALE_PRIORS.logRatio);
    const fair = saleProbability({ ask: 100, predictedMedian: 100, daysOut: 14, curve });
    const rich = saleProbability({ ask: 180, predictedMedian: 100, daysOut: 14, curve });
    const before = saleProbability({ ask: 100, predictedMedian: 100, daysOut: 14 });
    expect(fair).toBeGreaterThan(rich);
    expect(fair).toBeGreaterThan(before);
  });

  it("reads a sell-now offer from the pair total or the per-ticket amount", () => {
    const both = parseInstantOffer({ game: "2026-11-15", offeredTotal: "$26.60", perTicket: "13.30" });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.offer.total).toBe(26.6);
    expect(both.offer.perTicket).toBe(13.3);

    const pairOnly = parseInstantOffer({ game: "2026-11-15", offeredTotal: 26.6 });
    expect(pairOnly.ok).toBe(true);
    if (!pairOnly.ok) return;
    expect(pairOnly.offer.perTicket).toBe(13.3);

    const mismatch = parseInstantOffer({ game: "2026-11-15", offeredTotal: 26.6, perTicket: 20 });
    expect(mismatch.ok).toBe(false);
  });

  it("treats an instant offer as a guaranteed floor near tip and as an anchor in the fit", () => {
    const near = suggestListPrice({
      predictedMedian: 40,
      daysOut: 3,
      instantTotal: 500,
      instantPerTicket: 250,
    });
    expect(near.takeInstant).toBe(true);
    expect(near.ask).toBeNull();
    expect(near.sentence).toMatch(/Take the instant offer/);
    expect(near.sentence).toMatch(/\$500\.00/);
    expect(near.sentence).not.toMatch(/Nothing is listed/);

    const later = suggestListPrice({
      predictedMedian: 40,
      daysOut: 30,
      instantTotal: 500,
      instantPerTicket: 250,
    });
    expect(later.takeInstant).toBe(false);
    expect(later.ask).not.toBeNull();

    const cleared = suggestListPrice({
      predictedMedian: 200,
      daysOut: 2,
      instantTotal: 50,
      instantPerTicket: 25,
    });
    expect(cleared.takeInstant).toBe(false);
    expect(cleared.expectedKeep ?? 0).toBeGreaterThanOrEqual(50);

    const noPrice = offersNearTip([], 26.6, 2);
    expect(noPrice.takeInstant).toBe(false);
    expect(noPrice.offers).toEqual([]);

    const rows: MarketRow[] = [];
    const levels = [
      { date: "2026-11-01", instant: 20, level: 4.9 },
      { date: "2026-11-08", instant: 22, level: 4.95 },
      { date: "2026-12-01", instant: 80, level: 5.45 },
      { date: "2026-12-08", instant: 84, level: 5.5 },
    ];
    for (const game of levels) {
      for (let day = 0; day < 8; day += 1) {
        rows.push({
          gameDate: game.date,
          snapshotDate: addDays("2026-08-01", day),
          daysOut: 40 + day,
          median: Math.exp(game.level),
          tier: "standard",
          weekend: false,
          nationalTv: false,
          winRate: 0.5,
          supply: 6,
          instantPerTicket: game.instant,
        });
      }
    }
    const fit = fitMarketModel(rows, "2026-10-01", { knots: [7, 21, 45, 90] });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.terms).toContain("logInstant");
    const weight = fit.beta[fit.terms.indexOf("logInstant")] ?? 0;
    expect(weight).toBeGreaterThan(0);
    const lifted = projectGame(
      fit,
      query({ gameDate: "2026-11-01", daysOut: 20, liveMedian: null, instantPerTicket: 200 }),
    );
    expect(lifted.todayPrice).toBeGreaterThanOrEqual(210);
  });

  it("explains the model without technical jargon", () => {
    const note = modelExplainer();
    expect(note).toMatch(/early estimate/i);
    expect(note).toMatch(/latest middle of similar seats/);
    expect(note).toMatch(/no listings yet gets a price from similar games/);
    expect(note).toMatch(/leaving out singles/);
    expect(note).toMatch(/\$6,000/);
    expect(note).toMatch(/15%/);
    expect(note).toMatch(/possible sale/i);
    expect(note).toMatch(/instant offer/i);
    expect(note).toMatch(/take the instant offer/i);
    expect(note).toMatch(/nothing is listed automatically/);
    expect(note).not.toMatch(/regression|spline|logit|logistic|bayes|hierarchical|coefficient|prior|empirical/i);
  });

  it("refits from the cron path and only inserts fit rows", () => {
    const schedule = readFileSync(new URL("../worker/schedule.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../worker/model-fit.ts", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../migrations/0004_price_model.sql", import.meta.url), "utf8");
    expect(schedule).toContain("refitPriceModel");
    expect(store).toContain("INSERT INTO price_model_fits");
    expect(store).not.toMatch(/UPDATE price_model_fits|DELETE FROM price_model_fits/i);
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS price_model_fits");
    expect(migration).not.toMatch(/UPDATE |DELETE /i);

    const salesMigration = readFileSync(new URL("../migrations/0005_likely_sales.sql", import.meta.url), "utf8");
    const salesStore = readFileSync(new URL("../worker/likely-sales.ts", import.meta.url), "utf8");
    const schema = readFileSync(new URL("../src/shared/archive-schema.ts", import.meta.url), "utf8");
    expect(salesMigration).toContain("CREATE TABLE IF NOT EXISTS likely_sales");
    expect(salesMigration).not.toMatch(/UPDATE |DELETE /i);
    expect(salesStore).toContain("INSERT INTO likely_sales");
    expect(salesStore).toContain("ON CONFLICT(external_id) DO NOTHING");
    expect(salesStore).not.toMatch(/UPDATE likely_sales|DELETE FROM likely_sales/i);
    expect(schema).toContain("LIKELY_SALES_DDL");
    expect(schema).not.toMatch(/UPDATE likely_sales|DELETE FROM likely_sales/i);

    const offerMigration = readFileSync(new URL("../migrations/0006_instant_offers.sql", import.meta.url), "utf8");
    const offerStore = readFileSync(new URL("../worker/instant-offers.ts", import.meta.url), "utf8");
    expect(offerMigration).toContain("CREATE TABLE IF NOT EXISTS instant_offers");
    expect(offerMigration).toContain("tm_instant_offer");
    expect(offerMigration).not.toMatch(/UPDATE |DELETE /i);
    expect(offerStore).toContain("INSERT INTO instant_offers");
    expect(offerStore).not.toMatch(/UPDATE instant_offers|DELETE FROM instant_offers/i);
    expect(schema).toContain("INSTANT_OFFER_DDL");
  });
});

describe("opponent tiers", () => {
  it("uses the 2026-27 lists unless the game sets its own demand", () => {
    expect(opponentTier("Houston Rockets", null)).toBe("marquee");
    expect(opponentTier("Miami Heat", null)).toBe("marquee");
    expect(opponentTier("Detroit Pistons", null)).toBe("standard");
    expect(opponentTier("Milwaukee Bucks", null)).toBe("standard");
    expect(opponentTier("Portland Trail Blazers", null)).toBe("standard");
    expect(opponentTier("Memphis Grizzlies", null)).toBe("soft");
    expect(opponentTier("LA  Clippers", undefined)).toBe("soft");
    expect(opponentTier("Detroit Pistons", "bigger")).toBe("marquee");
    expect(opponentTier("Houston Rockets", "soft")).toBe("soft");
  });
});

describe("chance display", () => {
  it("never shows a model probability as 0% or 100%", async () => {
    const { formatChance } = await import("@shared/format");
    expect(formatChance(1)).toBe("over 99%");
    expect(formatChance(0.996)).toBe("over 99%");
    expect(formatChance(0.72)).toBe("72%");
    expect(formatChance(0.001)).toBe("under 1%");
  });
});
