-- Daily suggested per-seat type-in. Append-only: the first row for a game and ET day stays.
-- origin is 'snapshot' for a live model save, or 'recomputed' for a backfill from that day's comps.
CREATE TABLE IF NOT EXISTS suggested_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  game_date TEXT NOT NULL,
  et_date TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  ask REAL NOT NULL,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  method TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggested_asks_game_day
  ON suggested_asks (game_date, et_date);

CREATE INDEX IF NOT EXISTS idx_suggested_asks_day
  ON suggested_asks (et_date);
