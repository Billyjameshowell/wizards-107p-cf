-- Possible sales. A vanished comparable pair, or a fetched sale row.
-- Append-only. certain = 0 is a possible sale, not a sure one.
CREATE TABLE IF NOT EXISTS likely_sales (
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
