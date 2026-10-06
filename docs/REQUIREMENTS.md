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

`SOURCES=seatdata,apify` (comma list). Adapters normalize into the book, then persist.

1. **SeatData** — comps in 107 / 108 / 118 / 119, rows J–T, quantity ≥ 2. The suggestion uses the median of those listings, and leaves out one lone cheapest Section 107 Row P listing. It does not use the lowest price. Search is free; listings/sales consume pulls. Each successful listings check is saved in D1 `price_history` (one row per game per ET day; a later check that day replaces it). The middle blends those checks: recent days count more, a thin morning stays near the recent middle, and a morning with many comps follows the live median without taking the whole jump in one day. If the middle has stepped the same way on the last few busy checks, the blend leans a little further that way. A morning with no usable comps keeps the recent middle for 21 days, then shows no price. A game SeatData has not listed yet stays at no price until an event exists; the next run that sees the event can record the first real middle, because games with no check yet are looked at before games already checked. The same pull caps still apply.
2. **Apify** `lentic_clockss/seatgeek-scraper` — cheap list only (`includeListings: false` unless `APIFY_INCLUDE_LISTINGS=true`). Home games at Capital One Arena. Map `lowestPrice` / `medianPrice` / `listingCount`. Those arena figures are saved on `price_history` and do not set the suggestion.

Do not invent prices. TicketData scrape and auto-listing are out of scope.

## HARD spend caps (SAFE defaults)

| Flag / cap | Default | Rule |
| --- | --- | --- |
| `INGEST_ENABLED` | `false` | No paid calls until flipped |
| `DRY_RUN` | `true` | Even with ingest on, skip paid HTTP |
| SeatData pulls | 20 / run, 25 / ET-day | Env may lower, never raise |
| Apify | `maxTotalChargeUsd=0.50`, max 50 events | Listings off unless flagged |
| Paid attempts | 1 per source per run | Second try is blocked |
| 429 / 5xx | Abort that source | Open an ET-day circuit breaker |
| `/api/cron` | Bearer `CRON_SECRET` | Fail closed if secret missing |

Unit tests in `test/guardrails.test.ts` lock these rules. Saving price history does not add a paid call. It runs only after a pull that already passed these gates. There is no new flag. `INGEST_ENABLED` stays false and `DRY_RUN` stays true.

## HTTP and schedule

- `GET /api/book` — live book JSON (KV → D1 → seed).
- `GET|POST /api/cron` — same ingest as the cron, requires `Authorization: Bearer <CRON_SECRET>`.
- `scheduled()` — Cloudflare Cron Trigger; no bearer (platform invocation).

## Out of scope

Vercel, TicketData scrape, auto-listing on Ticketmaster, enabling paid ingest by default.
