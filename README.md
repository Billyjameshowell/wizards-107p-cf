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

Live: https://wizards.billycommandcenter.com/

https://wizards-107p-cf.dfm7gb44c6.workers.dev still works.

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

The daily job is four cron steps, one per invocation so each stays inside the Workers CPU and per-invocation limits (`worker/schedule.ts`): `0 12 * * *` ingest (comps pull, archive, price history, book), `10 12` refit (model fit, likely sales), `20 12` grid (suggested-ask snapshot, then the grid), `30 12` trends, all UTC (~8am America/New_York). The cron's minute picks the step. HTTP `/api/cron?step=ingest|refit|grid|trends` runs one step (default ingest) and **requires** `Authorization: Bearer <CRON_SECRET>`.

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
| `SOURCES` | `seatdata` | Apify is off. `seatdata,apify` turns it back on |
| `APIFY_INCLUDE_LISTINGS` | `false` | Leave false; listings are expensive |
| `SEATDATA_MAX_PULLS_PER_RUN` | `50` | Cannot be raised past 50. One run covers all 43 home games |
| `SEATDATA_MAX_PULLS_PER_ET_DAY` | `50` | Cannot be raised past 50. Daily dollars stop at $2 ($0.04 per charged pull) |
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

`secret list` shows names only. Put a secret only when the name is missing. Then the ~8am ET cron (or a Bearer call to `/api/cron`) may call SeatData, write the book to D1/KV, and the next page load shows new asks. One paid attempt per source per run. 429/5xx abort that source and trip an ET-day circuit breaker. SeatData stops at 50 pulls per run, 50 per ET day, and $2 per ET day. A charged pull is recorded at $0.04. Apify is not called.

`/admin` is the status page (HTTP Basic password is `CRON_SECRET`, or the same bearer as `/api/cron`). It warns when ingest is off, dry run is on, or the last successful pull is more than 3 days old. That warning is not on the public book.

To turn spend back off: edit `wrangler.jsonc` so `INGEST_ENABLED` is `"false"` or `DRY_RUN` is `"true"`, then redeploy.

## Ticketmaster pair comps (tm_comps)

`worker/tm-comps.ts` pulls Ticketmaster lower-bowl pair comps on Cloudflare, so nothing depends on the box being on. It uses the same spec, actor and input as the box scraper (`tm-scrape/scrape_tm.py`): `apify~playwright-scraper` on a US residential proxy, the `worker/tm/page_function.js` + `pre_nav_hook.js` pair, sections 100-127, rows N-T, 2+ seats, and the same side-of-arena tags. Parsing lives in `worker/tm-spec.ts`. A test checks it against the Python parser on the shared fixture.

- **Schedule (ET):** 10:00 and 17:00 full pulls, every day, for every unsold home game in the next 45 days. 18:00 is a game-day pull for today's game only, skipped once tip-off is 15 minutes away. There is one cron, `0,30 14,15,21,22,23 * * *` (UTC). It lists both the EDT and EST hours, and the code reads the ET clock to pick the job. The `:30` ticks are sweeps.
- **Flow:** the cron only starts Apify runs, each with an ad-hoc webhook to `POST /api/tm-comps/webhook` (signed with an HMAC of `CRON_SECRET`). The webhook handler does not trust the webhook body. It loads the run and its dataset from Apify and validates them: a challenge page or 0 listings is `blocked`, and fewer than 50% of the event's last good count is `partial`. On a good result it writes the target rows into D1 `tm_comps`. On a bad one it starts the next attempt on a fresh session pool, which means a fresh proxy IP, up to 3 attempts. After 3 bad attempts it keeps the attempt with the most listings. A `:30` sweep finishes any attempt whose webhook never arrived.
- **Spend:** before a pull starts any run, it checks the Apify account's monthly usage (`/v2/users/me/limits`). If usage is at the hard limit, the pull writes one `account_limit` row to `tm_runs` and returns: no starts, no retries, no spend. A start refused with the hard-limit error stops the rest of that pull the same way. Each attempt passes `maxTotalChargeUsd` 0.40 and a 300 s / 2 GB limit, and reserves `TM_ATTEMPT_RESERVE_USD` until its measured cost (`usageTotalUsd` plus any per-event charges) is written to `tm_runs.cost_usd`. A pull stops starting attempts at `TM_MAX_USD_PER_PULL` ($1, also the hard cap in code). The ET day stops at `TM_MAX_USD_PER_ET_DAY` ($3, hard cap $5).
- **Off switch:** set `TM_COMPS_ENABLED` to `"false"` and redeploy. The cron then does nothing.
- **Dedupe:** the unique index is (event_id, listing_id, section, row, seats, captured_at_et), and inserts use `INSERT OR IGNORE`. The box sync uses the same key.
- **Events:** `data/tm-home-events.json`, a copy of `wizards-tickets/tm-home-events.json`. Refresh it when the schedule changes.

Admin endpoints (HTTP Basic, password `CRON_SECRET`, or that value as a Bearer token):

```bash
curl -u admin:$CRON_SECRET "https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/admin/tm-comps.csv?event=2026-11-04&since=2026-10-30"
curl -u admin:$CRON_SECRET  https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/admin/tm-comps          # caps, spend today, cheapest 5 near 107 per game, last 30 attempts
curl -u admin:$CRON_SECRET -X POST "https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/admin/tm-comps/run?event=2026-11-04"   # manual pull (kind=full|gameday or event=)
curl -u admin:$CRON_SECRET -X POST  https://wizards-107p-cf.dfm7gb44c6.workers.dev/api/admin/tm-comps/sweep
```

`event` takes a date or a TM event id. `since` compares against `captured_at_et` (ISO with ET offset). The CSV has the box file's exact columns. On the box, `tm-scrape/sync_from_d1.py` appends new D1 rows to `tm-scrape/data/tm_comps.csv` and dedupes them on the same key.

Migration: `migrations/0011_tm_comps.sql` (tables `tm_comps`, `tm_runs`).

## Data

- Seed: `data/seed-book.json` (43 home games). Used when D1/KV are empty.
- Live book: D1 `store` key `book`, mirrored to KV `BOOK`.
- Spend-state: D1/KV key `spend` (caps and circuit breaker). Not shown on the page.
- Price history: D1 `price_history`, migration `migrations/0002_price_history.sql`. One row per game, source, and ET day. A later check the same day still replaces that summary row, and rows older than 120 days are still deleted from this table only. SeatData comp middles feed the suggestion, so it gets steadier as more mornings land. Apify get-in, arena median, and listing count are stored on the same table and do not set the ask. Migrations own the schema: the worker does not create this table. `0010_price_history_schema.sql` moves the Sept-15 table (captured_at shape) to `price_history_legacy` and creates the table above; until it ran, every morning's write and read failed in production.
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

`GET /api/freshness` is public and read-only. It returns each game’s last comp check and the last SeatData and Apify archive check, with `stale: true` when that check is 72 hours old or missing.

No new SQL migration. `price_pulls.cost_usd` already exists; the next charged listings pull writes 0.04 into it. Older rows stay as they are. Spend JSON in D1/KV gains `usdToday`; a saved spend row without that field counts as $0 for the current ET day.

Production ingest is on and dry run is off in `wrangler.jsonc`. Do not raise the SeatData ceilings past 50 pulls or $2. Crons stay the four 12:xx UTC steps. Do not rotate secrets for this change.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
