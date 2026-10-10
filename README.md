# Wizards 107P

Season ticket desk for Billy’s Washington Wizards seats — Capital One Arena **Section 107 Row P, seats 1–2**. Season cost is **$6,000**.

The page lists every home game with Sit vs Sell, what Billy keeps per seat, the whole-dollar number to type into Wizards “Set Your Price Per Ticket,” and whether the pair is listed or sold. He keeps 95% of that typed price (the seller fee on the Account Manager payout modal). Both seats pay twice the keep. A saved price stays when listings refresh.

**List nothing until Billy says so.** This site tracks status. It does not post listings to Ticketmaster.

This is a **Cloudflare Workers** full-stack app scaffolded with the official CLI, then filled in:

```bash
npm create cloudflare@latest -- . --framework=react
```

That is React + Vite + a Workers API + the Cloudflare Vite plugin ([docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)). Layout: `src/` (React), `worker/index.ts` (API), `wrangler.jsonc`. shadcn/ui, D1/KV, cron, and the SeatData/Apify adapters sit on top of that scaffold.

Morning cron writes the live book to D1/KV. The UI reads `/api/book`. No Vercel. No git commit is required to refresh prices.

Production `wrangler.jsonc` has paid pulls **on** (`INGEST_ENABLED=true`, `DRY_RUN=false`). Spend caps are unchanged. `wrangler deploy` replaces dashboard vars with that file, so those two flags have to stay on there or the next deploy stops the morning job. Local `.dev.vars` keeps pulls off and is not deployed.

Live: https://wizards-107p-cf.dfm7gb44c6.workers.dev

Production D1, KV, and the archive R2 bucket are wired in `wrangler.jsonc`. `CRON_SECRET`, `SEATDATA_API_KEY`, and `APIFY_TOKEN` are Workers secrets. Confirm the two API secrets are real keys before the first paid morning.

## Local

```bash
npm install
cp .dev.vars.example .dev.vars   # local CRON_SECRET; leave API keys empty; ingest stays off locally
npm run db:migrate:local
npm run dev                      # Vite + Workers runtime
```

Open the Vite URL. You should see the 43-game book from seed storage.

```bash
npm test
npm run build
```

Manual morning job (local):

```bash
curl -H "Authorization: Bearer change-me-local-only" http://localhost:5173/api/cron
# or the platform helper:
curl "http://localhost:5173/cdn-cgi/local/scheduled"
```

## Deploy

1. Create storage (once per account; already done for production):

```bash
npx wrangler d1 create wizards-107p
npx wrangler kv namespace create BOOK
```

2. Put the returned IDs into `wrangler.jsonc` (`database_id` and KV `id`).
3. Apply the D1 migration remotely:

```bash
npm run db:migrate:remote
```

4. Create the archive bucket once (raw provider JSON). D1 still holds the pull and listing rows:

```bash
npx wrangler r2 bucket create wizards-107p-archive
```

5. Confirm production secrets before deploy. `secret list` prints names only. Put a secret only when that name is missing. `SEATDATA_API_KEY` and `APIFY_TOKEN` have to be real keys, because this deploy turns paid pulls on:

```bash
npx wrangler secret list
npx wrangler secret put CRON_SECRET
npx wrangler secret put SEATDATA_API_KEY
npx wrangler secret put APIFY_TOKEN
```

6. Deploy (official C3 script):

```bash
npm run deploy
# same as: npm run build && wrangler deploy
```

7. Open the `*.workers.dev` URL. The book UI loads from `/api/book`. The first request also backfills the price archive (legacy rows, any existing `price_history` rows, and zone comps still sitting on the book). That backfill does not call SeatData or Apify.

Cron is `0 12 * * *` UTC (~8am America/New_York). After deploy, Cloudflare runs `scheduled()` on that schedule. HTTP `/api/cron` is the same job and **requires** `Authorization: Bearer <CRON_SECRET>`.

## Secrets and flags

Put **secrets** with Wrangler. They never belong in git.

| Secret | Purpose |
| --- | --- |
| `CRON_SECRET` | Bearer token for `/api/cron` |
| `SEATDATA_API_KEY` | SeatData API (comps in 107/108/118/119 J–T) |
| `APIFY_TOKEN` | Apify Actor `lentic_clockss/seatgeek-scraper` |

Flags are Worker **vars** in `wrangler.jsonc`. `npm run deploy` uploads that file and replaces any dashboard override. Production is already `INGEST_ENABLED=true` and `DRY_RUN=false`. Do not set those back to the off values in `wrangler.jsonc`.

| Flag | Production | Notes |
| --- | --- | --- |
| `INGEST_ENABLED` | `true` | A missing var still defaults off, so deleting it stops spend |
| `DRY_RUN` | `false` | A missing var still defaults on |
| `SOURCES` | `seatdata,apify` | Comma list of adapters |
| `APIFY_INCLUDE_LISTINGS` | `false` | Leave false; listings are expensive |
| `SEATDATA_MAX_PULLS_PER_RUN` | `20` | Cannot be raised past 20 |
| `SEATDATA_MAX_PULLS_PER_ET_DAY` | `25` | Cannot be raised past 25 |
| `APIFY_MAX_TOTAL_CHARGE_USD` | `0.50` | Cannot be raised past $0.50 |
| `APIFY_MAX_EVENTS` | `50` | Cannot be raised past 50 |
| `APIFY_ACTOR` | `ahmed_jasarevic~seatgeek-scraper` | Default is SeatGeek Platform API price stats. Allow-listed alternate: `lentic_clockss~seatgeek-scraper`. Anything else falls back to the default |
| `APIFY_ACTOR_BUILD` | empty | Optional build tag/number to pin (e.g. `0.1.72`) when the actor's latest build breaks |

`.dev.vars.example` sets the two local overrides to off. Copy it to `.dev.vars` (gitignored). That file does not affect production.

## Paid pulls

`wrangler.jsonc` already turns them on. The morning job still does nothing until `SEATDATA_API_KEY` and `APIFY_TOKEN` are real secrets:

```bash
npx wrangler secret list
npx wrangler secret put SEATDATA_API_KEY
npx wrangler secret put APIFY_TOKEN
```

`secret list` shows names only. Put a secret only when the name is missing. Then the ~8am ET cron (or a Bearer call to `/api/cron`) may call SeatData and Apify, write the book to D1/KV, and the next page load shows new asks. One paid attempt per source per run. 429/5xx abort that source and trip an ET-day circuit breaker. Caps stay 20/25 SeatData pulls and $0.50 Apify.

`/admin` is the status page (HTTP Basic password is `CRON_SECRET`, or the same bearer as `/api/cron`). It warns when ingest is off, dry run is on, or the last successful pull is more than 3 days old. That warning is not on the public book.

To turn spend back off: edit `wrangler.jsonc` so `INGEST_ENABLED` is `"false"` or `DRY_RUN` is `"true"`, then redeploy.

## Data

- Seed: `data/seed-book.json` (43 home games). Used when D1/KV are empty.
- Live book: D1 `store` key `book`, mirrored to KV `BOOK`.
- Spend-state: D1/KV key `spend` (caps and circuit breaker). Not shown on the page.
- Price history: D1 `price_history`, migration `migrations/0002_price_history.sql`. One row per game, source, and ET day. A later check the same day still replaces that summary row, and rows older than 120 days are still deleted from this table only. SeatData comp middles feed the suggestion, so it gets steadier as more mornings land. Apify get-in, arena median, and listing count are stored on the same table and do not set the ask. The worker also creates the table on the first run that writes it.
- Price archive: D1 `price_pulls`, `price_listings`, and `price_run_summaries`, migration `migrations/0003_price_archive.sql`. Every pull is appended. Nothing in these tables is updated or deleted. Each SeatData listings response keeps every listing row (section, row, quantity, price, and the other scalar fields). Apify keeps one run row plus one row per home game. Failed and skipped attempts are rows too. The raw JSON body is gzipped into R2 bucket `wizards-107p-archive` when that binding is present. The daily `price_history` summary is unchanged and still drives the suggestion.

Apply both migrations before the next deploy:

```bash
npx wrangler r2 bucket create wizards-107p-archive
npm run db:migrate:remote
npm run deploy
```

The worker creates the archive tables if the migration has not been applied yet, then loads them once:

- `data/legacy-price-history.json` (Aug 26–Sep 19 2026) as source `legacy-box`. Game rows are pulls. The three run-summary lines go to `price_run_summaries`. The original source label is `legacy_label`.
- Every row already in `price_history`, whether that table is the daily summary shape or the older per-run shape with `market_details`.
- `market_details` and `market_previous_details` on the live book, source `book-snapshot`, including their zone comps.

The flag is D1 `store` key `archive_backfill_v1`. A failed load leaves the key unset and the next request tries again. Inserts use `ON CONFLICT DO NOTHING`, so a retry does not duplicate rows.

Export is not linked from the book. It requires the same bearer token as `/api/cron` and sends `X-Robots-Tag: noindex`. `from` and `to` are America/New_York dates (`et_date`). CSV streams every matching row. JSON is paged (`limit` default 500, max 2000, `offset`).

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/export?format=csv&table=listings"
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/export?format=csv&table=pulls&game=2026-10-21&from=2026-08-26&to=2026-09-19&source=legacy-box"
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/export?format=json&table=summaries"
```

`table` is `pulls`, `listings`, or `summaries` (JSON also allows `all`).

No new flags. Production ingest is on and dry run is off in `wrangler.jsonc`. Do not raise the spend caps.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
