-- One row per game, source, and ET day. A later check the same day replaces it.
-- SeatData rows (source = 'seatdata') feed the suggestion blend.
-- Apify rows store get-in, arena median, and listing count. They do not set the ask.
-- Paid calls are unchanged: this table is written only after a run that already passed the spend gates.
CREATE TABLE IF NOT EXISTS price_history (
  game_date TEXT NOT NULL,
  source TEXT NOT NULL,
  et_date TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  median REAL,
  get_in REAL,
  listing_count INTEGER,
  comp_count INTEGER,
  excluded_dump INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_date, source, et_date)
);
