-- Append-only fits of the similar-seat price model. One row per cron run.
CREATE TABLE IF NOT EXISTS price_model_fits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fitted_at TEXT NOT NULL,
  et_date TEXT NOT NULL,
  version TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  game_count INTEGER NOT NULL,
  observed_games INTEGER NOT NULL,
  early INTEGER NOT NULL,
  blend REAL NOT NULL,
  sigma_resid REAL,
  sigma_game REAL,
  holdout_median_ape REAL,
  params_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_model_fits_fitted
  ON price_model_fits (fitted_at);
