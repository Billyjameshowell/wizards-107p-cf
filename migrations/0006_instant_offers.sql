-- Guaranteed sell-now offers. Append-only. One row each time one is logged.
CREATE TABLE IF NOT EXISTS instant_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date TEXT NOT NULL,
  offered_total REAL NOT NULL,
  per_ticket REAL NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'tm_instant_offer',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_instant_offers_game
  ON instant_offers (game_date, observed_at);
