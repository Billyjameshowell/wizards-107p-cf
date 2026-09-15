CREATE TABLE IF NOT EXISTS spend_pulls (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('seatdata', 'apify')),
  et_date TEXT NOT NULL,
  at TEXT NOT NULL,
  actual_usd REAL NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_spend_pulls_et_source_at ON spend_pulls (et_date, source, at DESC);

-- Preserve pre-ledger SeatData usage as an estimate, never invent a receipt.
-- Fixed ID makes application idempotent; only existing spend state is imported.
INSERT INTO spend_pulls (id, source, et_date, at, actual_usd, estimated_usd, reserved_usd, details)
SELECT 'legacy-seatdata-' || json_extract(value, '$.etDate'), 'seatdata',
       json_extract(value, '$.etDate'), updated_at, 0,
       COALESCE(json_extract(value, '$.sources.seatdata.pullsToday'), 0) * 0.04,
       COALESCE(json_extract(value, '$.sources.seatdata.pullsToday'), 0) * 0.04,
       json_object('kind', 'historical counters', 'status', 'estimated: receipts unavailable',
                   'pulls', COALESCE(json_extract(value, '$.sources.seatdata.pullsToday'), 0), 'eventsFetched', 0)
FROM store WHERE key = 'spend' AND json_valid(value)
  AND COALESCE(json_extract(value, '$.sources.seatdata.pullsToday'), 0) > 0
ON CONFLICT(id) DO NOTHING;

INSERT INTO spend_pulls (id, source, et_date, at, actual_usd, estimated_usd, reserved_usd, details)
SELECT 'legacy-apify-' || json_extract(value, '$.etDate'), 'apify',
       json_extract(value, '$.etDate'), updated_at, 0,
       COALESCE(json_extract(value, '$.sources.apify.paidAttemptsToday'), 0) * 0.50,
       COALESCE(json_extract(value, '$.sources.apify.paidAttemptsToday'), 0) * 0.50,
       json_object('kind', 'historical counters', 'status', 'estimated upper bound: run receipts unavailable',
                   'pulls', COALESCE(json_extract(value, '$.sources.apify.paidAttemptsToday'), 0), 'eventsFetched', 0)
FROM store WHERE key = 'spend' AND json_valid(value)
  AND COALESCE(json_extract(value, '$.sources.apify.paidAttemptsToday'), 0) > 0
ON CONFLICT(id) DO NOTHING;
