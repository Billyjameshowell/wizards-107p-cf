# Wizards 107P

Season ticket desk for Billy’s Washington Wizards seats — Capital One Arena **Section 107 Row P, seats 1–2**. Season cost is **$6,000**.

The page lists every home game with Sit vs Sell, the advised ask from the latest market pull, cash for both seats after Ticketmaster’s ~10% fee, and whether the pair is listed or sold.

**List nothing until Billy says so.** This site tracks status. It does not post listings to Ticketmaster.

This is a **Cloudflare Workers** full-stack app scaffolded with the official CLI, then filled in:

```bash
npm create cloudflare@latest -- . --framework=react
```

That is React + Vite + a Workers API + the Cloudflare Vite plugin ([docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)). Layout: `src/` (React), `worker/index.ts` (API), `wrangler.jsonc`. shadcn/ui, D1/KV, cron, and the SeatData/Apify adapters sit on top of that scaffold.

Morning cron writes the live book to D1/KV. The UI reads `/api/book`. No Vercel. No git commit is required to refresh prices.

Paid market pulls stay **off** until you flip flags.

Live: https://wizards-107p-cf.dfm7gb44c6.workers.dev

Production D1 and KV are provisioned and wired in `wrangler.jsonc`. `CRON_SECRET` is stored in Workers secrets; `SEATDATA_API_KEY` and `APIFY_TOKEN` contain disabled placeholders. `INGEST_ENABLED=false` and `DRY_RUN=true` keep paid pulls off.

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

Flags are Worker **vars** in `wrangler.jsonc` (SAFE defaults). To change them in production, edit `wrangler.jsonc` and redeploy:

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
| `SEATDATA_MAX_PULLS_PER_RUN` | `20` | Cannot be raised past 20 |
| `SEATDATA_MAX_PULLS_PER_ET_DAY` | `25` | Cannot be raised past 25 |
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
- Spend-state: D1/KV key `spend` (caps and circuit breaker). Not shown on the page.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
