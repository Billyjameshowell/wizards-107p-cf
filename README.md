# Wizards 107P

Season ticket desk for Billy’s Washington Wizards seats — Capital One Arena **Section 107 Row P, seats 1–2**. Season cost is **$6,000**.

The page lists every home game with Sit vs Sell, the advised ask from the latest market pull, cash for both seats after Ticketmaster’s ~10% fee, and whether the pair is listed or sold.

**List nothing until Billy says so.** This site tracks status. It does not post listings to Ticketmaster.

This is a **Cloudflare Workers** full-stack app scaffolded with the official CLI, then filled in:

```bash
npm create cloudflare@latest -- . --framework=react
```

That is React + Vite + a Workers API + the Cloudflare Vite plugin ([docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)). Layout: `src/` (React), `worker/index.ts` (API), `wrangler.jsonc`. shadcn/ui, D1/KV, cron, and the SeatData/Apify adapters sit on top of that scaffold.

Click **Market details +** under an opponent to expand arena get-in/median, lower-level prices, and custom-zone comps (sections 107/108/118/119, rows J–T, 2+ seats). Detail snapshots are retained starting with the next scheduled SeatData pull; older snapshots show unavailable fields honestly. Expanding a game does not make a paid request. The table shows the book update time; expanded records show their own market update time in Eastern Time. Older records without a saved timestamp are labeled accordingly.

Morning cron writes the live book to D1/KV. The UI reads `/api/book`. No Vercel. No git commit is required to refresh prices.

Paid market pulls are **enabled with hard caps** by Billy’s request. Missing credentials skip their source.

Live: https://wizards-107p-cf.dfm7gb44c6.workers.dev

Production D1 and KV are provisioned and wired in `wrangler.jsonc`. `CRON_SECRET` is stored in Workers secrets; Paid API keys are held in Workers secrets; missing or placeholder credentials are rejected before any provider request. Production uses `INGEST_ENABLED=true` and `DRY_RUN=false`. SeatData stays capped at 20 requests/run and 25/ET day; Apify at $0.50/run with listings off.

## Read-only status and indexing

Status: https://wizards-107p-cf.dfm7gb44c6.workers.dev/admin

Open `/admin/login` and sign in with your admin password and select **Remember me for 30 days** to stay signed in on that browser. Without it, the cookie lasts for the browser session (with a 24-hour server limit). Changing `CRON_SECRET` invalidates existing sessions. HTTP Basic authentication (`admin` / `CRON_SECRET`) and Bearer headers remain supported. The page displays run status, caps, usage counters, source errors, and prices. It has no controls to start pulls or change settings. Credentials never go in the URL. On Billy’s Mac, the admin password is stored in the gitignored `.secrets/cron-secret.txt`.

All responses carry `X-Robots-Tag: noindex, nofollow`; HTML includes the robots meta tag and `/robots.txt` disallows all crawling.

## Local

```bash
npm install
cp .dev.vars.example .dev.vars   # add a local CRON_SECRET; leave API keys empty
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

4. Put production secrets with Wrangler (do not commit them). `CRON_SECRET` is required for the protected HTTP cron endpoint. Replace the paid API placeholders with real keys before enabling paid ingest:

```bash
npx wrangler secret put CRON_SECRET
npx wrangler secret put SEATDATA_API_KEY
npx wrangler secret put APIFY_TOKEN
```

5. Deploy (official C3 script):

```bash
npm run deploy
# same as: npm run build && wrangler deploy
```

6. Open the `*.workers.dev` URL. The book UI loads from `/api/book`.

Cron is `0 12 * * *` UTC (~8am America/New_York). After deploy, Cloudflare runs `scheduled()` on that schedule. HTTP `/api/cron` is the same job and **requires** `Authorization: Bearer <CRON_SECRET>`.

## Secrets and flags

Put **secrets** with Wrangler. They never belong in git.

| Secret | Purpose |
| --- | --- |
| `CRON_SECRET` | Bearer token for `/api/cron` |
| `SEATDATA_API_KEY` | SeatData API (comps in 107/108/118/119 J–T) |
| `APIFY_TOKEN` | Apify Actor `lentic_clockss/seatgeek-scraper` |

Flags are Worker **vars** in `wrangler.jsonc`. Production is enabled; the code falls back to safe disabled flags when values are absent. To change them in production, edit `wrangler.jsonc` and redeploy:

```bash
npm run deploy
```

Keep the safe defaults until the paid credentials are present and you are ready to spend.

| Flag | SAFE default | Notes |
| --- | --- | --- |
| `INGEST_ENABLED` | `false` | Must be `true` before any paid call |
| `DRY_RUN` | `true` | Must be `false` before any paid call |
| `SOURCES` | `seatdata,apify` | Comma list of adapters |
| `APIFY_INCLUDE_LISTINGS` | `false` | Leave false; listings are expensive |
| `SEATDATA_MAX_PULLS_PER_RUN` | `20` | 20 normally; single-use seed 50 |
| `SEATDATA_MAX_PULLS_PER_ET_DAY` | `25` | 25 normally; single-use seed 100 |
| `APIFY_MAX_TOTAL_CHARGE_USD` | `0.50` | Cannot be raised past $0.50 |
| `APIFY_MAX_EVENTS` | `50` | Cannot be raised past 50 |

`.dev.vars.example` shows the local file shape. Copy it to `.dev.vars` (gitignored).

## How to enable ingest

First replace both paid API placeholders with real keys using the secret commands above. Money stays off until **both** flags flip in `wrangler.jsonc`:

```bash
# edit vars:
# INGEST_ENABLED: "true"
# DRY_RUN: "false"
npm run deploy
```

Then the ~8am ET cron (or a Bearer call to `/api/cron`) may call SeatData and Apify, write the book to D1/KV, and the next page load shows new asks. One paid attempt per source per run. 429/5xx abort that source and trip an ET-day circuit breaker.

To turn spend back off: edit the vars to set `INGEST_ENABLED: "false"` or `DRY_RUN: "true"`, then redeploy.

## Data

- Seed: `data/seed-book.json` (43 home games). Used when D1/KV are empty.
- Live book: D1 `store` key `book`, mirrored to KV `BOOK`.
- Spend-state: D1/KV key `spend` (caps and circuit breaker). Billing ledger: D1 `spend_pulls`; both shown on `/admin`.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Verified September 15, 2026: one morning pull at 11:36am ET used 20 SeatData requests and updated 20 game prices. Apify still needs a real token.


### Price history and baseline coverage

Successful game snapshots are retained in D1 by game, source, and pull time. The current book includes the previous comparable market snapshot so the UI can show `(current − previous) / previous × 100` beside each metric. First snapshots say **Baseline**; missing/zero prior prices do not produce a percentage. Comparisons use the same source and seating filters, and the expanded view shows both timestamps.

SeatData fills games without a detailed snapshot first, then rotates through the oldest snapshots. The existing 20-per-run / 25-per-Eastern-day limits still apply, so full-season coverage takes multiple runs. A failed request does not become a price snapshot. Opening the book or expanding details never starts a paid pull.


### Traditional table layout

The ticket book uses compact native HTML tables and plain CSS, inspired by [Haslametrics](https://haslametrics.com/): grouped column headers, alternating rows, colored links, and small NBA logos in Wizards navy/red/silver. The main table scrolls horizontally on narrow screens. Clicking an opponent expands price comparisons and a compact comps table. Official NBA logo sources are listed in `public/team-logos/README.md`; the SVGs are served locally.

## One-shot September 15 seed and spend accounting

`POST /ingest?seed=1` (also `POST /api/cron?seed=1`) requires the existing
`Authorization: Bearer <CRON_SECRET>`. It respects `INGEST_ENABLED` and `DRY_RUN`.
A durable D1 claim (`store.seed_20260915`) permits this seed **once**, including
across redeployments. A repeat returns `seed_already_claimed` without API calls.
The regular cron cannot activate seed mode.

Only this request raises SeatData ceilings to **50 pulls/run and 100/ET day**.
Normal requests retain **20/run and 25/ET day**, including usage from the seed.
The seed visits all future homes, including TBD games, and skips section snapshots
already captured today. It fetches listings once per game and derives 107/108/118/119,
rows J–T comps from that response. Sales are omitted to avoid unnecessary pulls.
Apify remains performer `washington-wizards`, max 50, listings off, charge cap $0.50.
No ticket listing or sale action exists in this flow.

The read-only HTML `/admin` retains Basic authentication and existing browser
sign-in, noindex headers, credentials/status/circuit panels, and displays billing
records, ET-day source totals, and their blended total. Actual and estimated USD
are separate: SeatData refreshed pulls use $0.04 PAYG; Apify uses terminal run
billing when available and otherwise keeps the reserved cap as an estimate.
Reservations are recorded before requests and survive failures/deployments.
Historical counters without billing receipts are labeled estimates.

If the seed is interrupted, its single-use claim stays consumed. Inspect the
ledger and book first; normal capped daily ingest can finish missing observations.
Do not remove the claim to retry blindly or raise the permanent hard caps.

Apify billing field reference: [Get run](https://docs.apify.com/api/v2/actor-run-get).
`usageTotalUsd` is the authenticated run owner's total charge; completion figures
can be preliminary, so billing should be read again after the documented settling
interval before calling the amount actual.

### Live seed result — 2026-09-15

The single-use seed ran at 13:39 ET. The book advanced from 21 to **23/43** homes
with advised asks, with **10** full SeatData section snapshots. SeatData returned
five refreshed pulls (**$0.20 actual**) before exhausting its account balance;
its billing endpoint reported `insufficient_balance`, zero credit, no subscription,
and no reset date. The remaining section seed is blocked until provider credit is
added. Rejected requests retain conservative estimates in the ledger rather than
being represented as confirmed charges.

Apify succeeded with 25 event rows / 12 home games for **$0.08 actual**, confirmed
by the settled run response. It stopped at its default one page. Future performer
runs explicitly allow two pages while retaining the hard 50-event/$0.50 limits.
The seed is not automatically repeated. Combined confirmed seed cost: **$0.28**.
The ledger additionally contains **$1.12** in uncertain rejected-pull estimates and
**$1.50** in pre-ledger historical upper estimates; these are not confirmed bills.
Daily displayed total at handoff: $0.28 actual + $2.62 estimated = $2.90.

Payment/authentication rejections now stop the source immediately and open its
ET-day circuit. Normal caps remain 20/25, and the seed claim remains consumed.
