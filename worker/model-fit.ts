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
import { loadMarketInputs, type MarketInputs } from "./trends";

const INSERT_FIT = `INSERT INTO price_model_fits (
  fitted_at, et_date, version, trigger_name, row_count, game_count, observed_games,
  early, blend, sigma_resid, sigma_game, holdout_median_ape, params_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The refit step: model fit and likely sales. Reads the archive once. The grid step writes the ask snapshot. */
export async function refitPriceModel(env: Env, trigger: string, now = new Date()): Promise<void> {
  await ensureArchive(env);
  const inputs = await loadMarketInputs(env);
  try {
    await insertModelFit(env, fitFromInputs(inputs, trigger, now));
  } catch (error) {
    console.error("price model fit", error);
  }
  try {
    await insertProbableSales(env, proxySales(inputs.pulls, inputs.listings), now);
  } catch (error) {
    console.error("likely sales", error);
  }
}

async function insertModelFit(env: Env, saved: StoredModelFit): Promise<void> {
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

export async function prepareModelFit(env: Env, trigger: string, now = new Date()): Promise<StoredModelFit> {
  await ensureArchive(env);
  return fitFromInputs(await loadMarketInputs(env), trigger, now);
}

function fitFromInputs(inputs: MarketInputs, trigger: string, now: Date): StoredModelFit {
  return fitFromArchive({
    today: etYmd(now),
    ...inputs,
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
  instantOffers?: Parameters<typeof cleanedMarketRows>[0]["instantOffers"];
  fittedAt: string;
  etDate: string;
  trigger: string;
}): StoredModelFit {
  const rows = cleanedMarketRows({
    today: input.today,
    games: input.games,
    pulls: input.pulls,
    listings: input.listings,
    instantOffers: input.instantOffers,
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
