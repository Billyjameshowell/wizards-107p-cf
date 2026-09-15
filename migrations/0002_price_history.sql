-- Durable per-run market snapshots. Each source/game/run timestamp is one
-- immutable observation; nullable metrics are intentional (a successful pull
-- can report an empty market).
CREATE TABLE IF NOT EXISTS price_history (
  game_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seatdata', 'apify')),
  captured_at TEXT NOT NULL,
  advised_ask REAL,
  get_in REAL,
  median REAL,
  listing_count INTEGER,
  last_sale REAL,
  market_details TEXT,
  PRIMARY KEY (game_date, source, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_price_history_game_source_captured
  ON price_history (game_date, source, captured_at DESC);
