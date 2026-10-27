-- Every 107P sale, append-only, with the model ask and newest TM read snapshotted at sale time.
CREATE TABLE IF NOT EXISTS sale_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  game_date TEXT NOT NULL,
  event_id TEXT,
  sold_at TEXT NOT NULL,
  seats_sold INTEGER,
  sold_price_per_seat REAL,
  payout_per_seat REAL,
  payout_total REAL,
  model_ask_at_sale REAL,
  tm_suggested_at_sale REAL,
  days_before_game INTEGER,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_outcomes_game ON sale_outcomes (game_date);
