# Wizards 107P — requirements

Billy owns Capital One Arena **Section 107 Row P seats 1–2**. Season cost is **$6,000** (the running cash goal only; it does not pull a game’s price down). This Worker app is the live ticket book: sit vs sell, what he keeps per seat, the number to type into Wizards “Set Your Price,” and the gap vs $6k.

He keeps **95%** of the whole-dollar price he types. That is the seller service fee on the Account Manager payout modal ($49 typed → $2.45 fee → $46.55 kept → $93.10 for the pair). The buyer pays more than the typed price. The book does not invent that buyer total.

The site **does not list tickets**. It tracks status. Nothing is posted to Ticketmaster unless Billy says so.

## Product

- Human-facing UI only. No ingest, cron, circuit, adapter, or storage jargon on the page.
- Sticky table header while scrolling the book.
- Morning market pull can update D1/KV without a git commit.
- Seed book: 43 home games (opponent, date, sit/sell, notes). Prices stay `—` until a real pull writes them.

## Stack

- Cloudflare Workers full-stack from `npm create cloudflare@latest -- . --framework=react` (React + Vite + Workers API + Vite plugin). Not Vercel, not Pages-only.
- React + Vite + TypeScript.
- shadcn/ui (`npx shadcn@latest init -d --base radix`) with table, card, and button.
- Durable store: D1 (`store` table) is source of truth; KV (`BOOK`) caches the same JSON for live reads.
- Cron Trigger `0 12 * * *` UTC (~8am America/New_York).
- Secrets via `wrangler secret put` (never committed).

## Data pipes

`SOURCES=seatdata` (comma list). Apify stays in the allow-list but is off: the SeatGeek actor returns no Wizards home rows, and the free section-107 fallbacks do not return prices. `SOURCES=seatdata,apify` turns it back on. Adapters normalize into the book, then persist.

1. **SeatData** — comps in 107 / 108 / 118 / 119, rows J–T, quantity ≥ 2. The suggestion uses the median of those listings, and leaves out one lone cheapest Section 107 Row P listing. It does not use the lowest price. Search is free; listings/sales consume pulls. Each successful listings check is saved in D1 `price_history` (one row per game per ET day; a later check that day replaces it). The same pull is also appended, with every listing row, to the archive tables (`price_pulls`, `price_listings`); that archive is not trimmed. Raw JSON goes to R2. `GET /api/export` (Bearer `CRON_SECRET`, noindex, not linked on the page) dumps it. The middle blends those checks: recent days count more, a thin morning stays near the recent middle, and a morning with many comps follows the live median without taking the whole jump in one day. If the middle has stepped the same way on the last few busy checks, the blend leans a little further that way. A morning with no usable comps keeps the recent middle for 21 days, then shows no price. A game SeatData has not listed yet stays at no price until an event exists; the next run that sees the event can record the first real middle, because games with no check yet are looked at before games already checked. That includes the TBD Cup date. After never-checked games, games within 14 days come next, then the stalest. The $2 day cap still applies.
2. **Apify** `ahmed_jasarevic~seatgeek-scraper` — off in production. It returns no Wizards home rows. Ticketmaster Discovery (event min/max only, and it needs an API key), SeatGeek’s Capital One Arena search (client id required), and TicketData (get-in price, no section 107) do not replace it. The adapter remains for `SOURCES=seatdata,apify`. When it is on, it is a cheap list only (`includeListings: false` unless `APIFY_INCLUDE_LISTINGS=true`). Those arena figures are saved on `price_history` and do not set the suggestion.

Do not invent prices. TicketData scrape and auto-listing are out of scope.

## HARD spend caps (SAFE defaults)

| Flag / cap | Default | Rule |
| --- | --- | --- |
| `INGEST_ENABLED` | on in `wrangler.jsonc` | Missing var still defaults off |
| `DRY_RUN` | off in `wrangler.jsonc` | Missing var still defaults on |
| SeatData pulls | 50 / run, 50 / ET-day, $2 / ET-day | Env may lower, never raise. A charged pull is $0.04. 43 games × $0.04 = $1.72, so the whole slate fits every day. If a full day would pass $2, games within 14 days still refresh daily and farther games refresh every 2 days (about 48h). |
| Apify | `maxTotalChargeUsd=0.50`, max 50 events | Listings off unless flagged |
| Paid attempts | 1 per source per run | Second try is blocked |
| 429 / 5xx | Abort that source | Open an ET-day circuit breaker |
| `/api/cron` | Bearer `CRON_SECRET` | Fail closed if secret missing |

Unit tests in `test/guardrails.test.ts` lock the caps and the empty-env defaults. Production `wrangler.jsonc` sets ingest on and dry run off; `wrangler deploy` replaces dashboard vars with that file. Do not put the empty-env defaults back into `wrangler.jsonc`. Saving price history does not add a paid call. It runs only after a pull that already passed these gates. A charged SeatData listings pull writes `price_pulls.cost_usd` = 0.04. A listings response that did not refresh writes 0. `GET /api/freshness` is public read-only JSON (per game, per source, stale at 72h or never).

## HTTP and schedule

- `GET /api/book` — live book JSON (KV → D1 → seed).
- `GET /api/freshness` — public read-only JSON. Per-game and per-source last-checked age, `stale` when that check is 72h or older, or missing.
- `GET|POST /api/cron` — same ingest as the cron, requires `Authorization: Bearer <CRON_SECRET>`.
- `scheduled()` — Cloudflare Cron Trigger; no bearer (platform invocation).

## Out of scope

Vercel, TicketData scrape, auto-listing on Ticketmaster, enabling paid ingest by default.
