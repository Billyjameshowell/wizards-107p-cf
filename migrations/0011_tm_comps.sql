-- Ticketmaster lower-bowl pair comps (sections 100-127, rows N-T, 2+ seats) pulled by the
-- Worker cron through Apify (worker/tm-comps.ts). Same columns as the box scraper's
-- tm-scrape/data/tm_comps.csv, so both paths feed one dataset.
CREATE TABLE IF NOT EXISTS tm_comps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at_et TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  run_status TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  opponent TEXT NOT NULL,
  section TEXT NOT NULL,
  row TEXT NOT NULL,
  seats TEXT NOT NULL,
  qty_available INTEGER,
  price_per_ticket_listed REAL,
  price_per_ticket_all_in REAL,
  fees_included INTEGER NOT NULL,
  listing_type TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  is_lower_bowl INTEGER NOT NULL,
  in_target_rows INTEGER NOT NULL,
  is_pair INTEGER NOT NULL,
  near_107 INTEGER NOT NULL,
  side_of_arena TEXT NOT NULL,
  source TEXT NOT NULL
);
-- Dedupe key shared with the box path: one row per listing per capture.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_comps_dedupe
  ON tm_comps (event_id, listing_id, section, row, seats, captured_at_et);
CREATE INDEX IF NOT EXISTS idx_tm_comps_event ON tm_comps (event_date, captured_at_et);
CREATE INDEX IF NOT EXISTS idx_tm_comps_captured ON tm_comps (captured_at_et);

-- One row per Apify attempt (and one per skipped pull, e.g. account_limit). Spend ledger for
-- the per-pull and per-ET-day caps.
CREATE TABLE IF NOT EXISTS tm_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  event_id TEXT,
  event_date TEXT,
  opponent TEXT,
  nonce TEXT UNIQUE,
  session_pool TEXT,
  apify_run_id TEXT,
  dataset_id TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  raw_listings INTEGER,
  target_rows INTEGER,
  runtime_s REAL,
  cost_usd REAL,
  reserved_usd REAL NOT NULL DEFAULT 0,
  et_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tm_runs_status ON tm_runs (status, started_at);
CREATE INDEX IF NOT EXISTS idx_tm_runs_run ON tm_runs (run_id, attempt);
CREATE INDEX IF NOT EXISTS idx_tm_runs_day ON tm_runs (et_date);
CREATE INDEX IF NOT EXISTS idx_tm_runs_apify ON tm_runs (apify_run_id);
