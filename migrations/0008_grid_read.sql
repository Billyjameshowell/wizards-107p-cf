-- Narrow reads for the daily price-grid rebuild. The request path does not query these.
CREATE INDEX IF NOT EXISTS idx_price_pulls_grid
  ON price_pulls (id)
  WHERE game_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_price_listings_priced
  ON price_listings (id, pull_id)
  WHERE price > 0;
