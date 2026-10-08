/**
 * Append-only price archive. Inserts use ON CONFLICT DO NOTHING.
 * Nothing in this script updates or deletes a pull, listing, or summary.
 */
export const ARCHIVE_DDL = `-- Full resale pulls. One row per source/game/run. Never replaced.
CREATE TABLE IF NOT EXISTS price_pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  pulled_at TEXT NOT NULL,
  et_date TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  source TEXT NOT NULL,
  game_date TEXT,
  opponent TEXT,
  status TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  http_status INTEGER,
  error TEXT,
  listing_count INTEGER,
  median REAL,
  get_in REAL,
  comp_count INTEGER,
  excluded_dump INTEGER NOT NULL DEFAULT 0,
  est_ask REAL,
  live_ask REAL,
  legacy_label TEXT,
  raw_key TEXT,
  raw_bytes INTEGER,
  note TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_pulls_game_pulled
  ON price_pulls (game_date, pulled_at);

CREATE INDEX IF NOT EXISTS idx_price_pulls_pulled
  ON price_pulls (pulled_at);

CREATE INDEX IF NOT EXISTS idx_price_pulls_source_pulled
  ON price_pulls (source, pulled_at);

-- Every listing row a pull returned. pull_id points at price_pulls.
CREATE TABLE IF NOT EXISTS price_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id INTEGER NOT NULL,
  game_date TEXT,
  section TEXT,
  row TEXT,
  quantity INTEGER,
  price REAL,
  active INTEGER,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_listings_pull
  ON price_listings (pull_id);

CREATE INDEX IF NOT EXISTS idx_price_listings_game
  ON price_listings (game_date);

-- Pre-app run summaries (sell-book totals). Not game rows.
CREATE TABLE IF NOT EXISTS price_run_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  pulled_at TEXT NOT NULL,
  et_date TEXT NOT NULL,
  source TEXT NOT NULL,
  sell_book_cash REAL,
  vs_6k REAL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_run_summaries_pulled
  ON price_run_summaries (pulled_at);
`;

/** Append-only model fits. Separate from the archive DDL so that script stays a copy of its migration. */
export const MODEL_FIT_DDL = `CREATE TABLE IF NOT EXISTS price_model_fits (
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
`;

/** Possible sales. Append-only. certain = 0 is a vanished pair, not a sure sale. */
export const LIKELY_SALES_DDL = `CREATE TABLE IF NOT EXISTS likely_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  et_date TEXT NOT NULL,
  game_date TEXT NOT NULL,
  seen_date TEXT NOT NULL,
  gone_date TEXT NOT NULL,
  days_out REAL NOT NULL,
  section TEXT NOT NULL,
  row_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  certain INTEGER NOT NULL DEFAULT 0,
  external_id TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_likely_sales_game
  ON likely_sales (game_date);
`;
