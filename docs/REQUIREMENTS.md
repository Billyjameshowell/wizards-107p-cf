# Wizards 107P — requirements

Billy owns Capital One Arena **Section 107 Row P seats 1–2**. Season cost is **$6,000**. This Worker app is the live ticket book: sit vs sell, advised ask, cash for both seats after Ticketmaster’s ~10% fee, and the gap vs $6k.

The site **does not list tickets**. It tracks status. Nothing is posted to Ticketmaster unless Billy says so.

## Product

- Human-facing UI only. No ingest, cron, circuit, adapter, or storage jargon on the page.
- Sticky table header while scrolling the book.
- Morning market pull can update D1/KV without a git commit.
- Seed book: 43 home games (opponent, date, sit/sell, notes). Prices stay `—` until a real pull writes them.

## Stack

- Cloudflare Workers full-stack (Vite + React + Workers Assets), not Vercel, not Pages-only.
- React + Vite + TypeScript.
- shadcn/ui (`npx shadcn@latest init -d --base radix`) with table, card, and button.
- Durable store: D1 (`store` table) is source of truth; KV (`BOOK`) caches the same JSON for live reads.
- Cron Trigger `0 12 * * *` UTC (~8am America/New_York).
- Secrets via `wrangler secret put` (never committed).

## Data pipes

`SOURCES=seatdata,apify` (comma list). Adapters normalize into the book, then persist.

1. **SeatData** — comps in 107 / 108 / 118 / 119, rows J–T. Going ask = lowest active listing with quantity ≥ 2. Search is free; listings/sales consume pulls.
2. **Apify** `lentic_clockss/seatgeek-scraper` — cheap list only (`includeListings: false` unless `APIFY_INCLUDE_LISTINGS=true`). Home games at Capital One Arena. Map `lowestPrice` / `medianPrice` / `listingCount`.

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

Unit tests in `test/guardrails.test.ts` lock these rules.

## HTTP and schedule

- `GET /api/book` — live book JSON (KV → D1 → seed).
- `GET|POST /api/cron` — same ingest as the cron, requires `Authorization: Bearer <CRON_SECRET>`.
- `scheduled()` — Cloudflare Cron Trigger; no bearer (platform invocation).

## Out of scope

Vercel, TicketData scrape, auto-listing on Ticketmaster, enabling paid ingest by default.
