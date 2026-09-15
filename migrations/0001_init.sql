-- Live ticket book and spend-state. Cron writes; the UI reads /api/book.
CREATE TABLE IF NOT EXISTS store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
