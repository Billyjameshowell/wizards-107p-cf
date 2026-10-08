import { etDateFrom } from "../src/shared/guardrails";
import { etYmd } from "../src/shared/pricing";
import {
  cleanedMarketRows,
  type TrendListing,
  type TrendPull,
  type TrendsGameSeed,
} from "../src/shared/trends";
import {
  fitMarketModel,
  holdoutMedianAbsPercent,
  storedModelFit,
  type StoredModelFit,
} from "../src/shared/price-model";
import { proxySales } from "../src/shared/trends";
import { ensureArchive } from "./archive-store";
import { insertProbableSales } from "./likely-sales";
import { loadLiveBook } from "./store";
import { loadTrendListings, loadTrendPulls, toSeed } from "./trends";

const INSERT_FIT = `INSERT INTO price_model_fits (
  fitted_at, et_date, version, trigger_name, row_count, game_count, observed_games,
  early, blend, sigma_resid, sigma_game, holdout_median_ape, params_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function refitPriceModel(env: Env, trigger: string, now = new Date()): Promise<void> {
  try {
    await insertModelFit(env, trigger, now);
  } catch (error) {
    console.error("price model fit", error);
  }
  try {
    await ensureArchive(env);
    const [pulls, listings] = await Promise.all([loadTrendPulls(env), loadTrendListings(env)]);
    await insertProbableSales(env, proxySales(pulls, listings), now);
  } catch (error) {
    console.error("likely sales", error);
  }
}

async function insertModelFit(env: Env, trigger: string, now: Date): Promise<void> {
  const saved = await prepareModelFit(env, trigger, now);
  if (!saved) return;
  await env.DB.prepare(INSERT_FIT)
    .bind(
      saved.fittedAt,
      saved.etDate,
      saved.version,
      saved.trigger,
      saved.rows,
      saved.games,
      saved.observedGames,
      saved.early,
      saved.blend,
      saved.sigma,
      saved.sigmaGame,
      saved.holdoutMedianAbsPercent,
      saved.paramsJson,
    )
    .run();
}

export async function prepareModelFit(env: Env, trigger: string, now = new Date()): Promise<StoredModelFit | null> {
  await ensureArchive(env);
  const today = etYmd(now);
  const book = await loadLiveBook(env);
  const [pulls, listings] = await Promise.all([loadTrendPulls(env), loadTrendListings(env)]);
  return fitFromArchive({
    today,
    games: book.games.map(toSeed),
    pulls,
    listings,
    fittedAt: now.toISOString(),
    etDate: etDateFrom(now),
    trigger,
  });
}

export function fitFromArchive(input: {
  today: string;
  games: readonly TrendsGameSeed[];
  pulls: readonly TrendPull[];
  listings: readonly TrendListing[];
  fittedAt: string;
  etDate: string;
  trigger: string;
}): StoredModelFit {
  const rows = cleanedMarketRows({
    today: input.today,
    games: input.games,
    pulls: input.pulls,
    listings: input.listings,
  });
  const fit = fitMarketModel(rows, input.today);
  const holdout = holdoutMedianAbsPercent(rows, input.today);
  return storedModelFit({
    fit,
    holdoutMedianAbsPercent: holdout,
    fittedAt: input.fittedAt,
    etDate: input.etDate,
    trigger: input.trigger,
  });
}

export type SavedModelStatus = {
  fittedAt: string | null;
  version: string | null;
  rows: number | null;
  early: boolean | null;
  holdoutMedianAbsPercent: number | null;
};

export async function latestSavedModel(env: Env): Promise<SavedModelStatus | null> {
  try {
    await ensureArchive(env);
    const row = await env.DB.prepare(
      `SELECT fitted_at, version, row_count, early, holdout_median_ape
       FROM price_model_fits
       ORDER BY id DESC
       LIMIT 1`,
    ).first<{
      fitted_at: string;
      version: string;
      row_count: number;
      early: number;
      holdout_median_ape: number | null;
    }>();
    if (!row) return null;
    return {
      fittedAt: row.fitted_at,
      version: row.version,
      rows: row.row_count,
      early: row.early === 1,
      holdoutMedianAbsPercent: row.holdout_median_ape,
    };
  } catch (error) {
    console.error("price model read", error);
    return null;
  }
}
