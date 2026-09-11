interface Env {
  DB: D1Database;
  BOOK: KVNamespace;
  SEATDATA_API_KEY?: string;
  APIFY_TOKEN?: string;
  CRON_SECRET?: string;
  INGEST_ENABLED?: string;
  DRY_RUN?: string;
  SOURCES?: string;
  APIFY_INCLUDE_LISTINGS?: string;
  SEATDATA_BASE_URL?: string;
  SEATDATA_MAX_PULLS_PER_RUN?: string;
  SEATDATA_MAX_PULLS_PER_ET_DAY?: string;
  APIFY_MAX_TOTAL_CHARGE_USD?: string;
  APIFY_MAX_EVENTS?: string;
}
