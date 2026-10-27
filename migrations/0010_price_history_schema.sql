-- Production's price_history was created on 2026-09-15 with the first schema
-- (captured_at, advised_ask, market_details, ...). 0002 was later rewritten to the
-- per-ET-day shape below, but an applied migration never re-runs, so every write
-- and read of et_date/comp_count failed there. Those 129 legacy rows were already
-- copied into price_pulls by the archive backfill (archive_backfill_v1).
-- Keep them under a new name, and create the table the code uses.
-- On a database built from 0002 this renames an empty table of the same shape.
ALTER TABLE price_history RENAME TO price_history_legacy;

CREATE TABLE price_history (
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
