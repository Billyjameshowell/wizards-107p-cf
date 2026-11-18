# Zards: port plan from Cloudflare Workers to Vercel

Linear: OWEX-343. Draft only. Production stays on Cloudflare (Apple-ID account) until this plan is built, tested on a preview, and Billy says go.

## What runs today

| Piece | Cloudflare today | Vercel target |
| --- | --- | --- |
| React + Vite SPA (`src/`) | Workers static assets, SPA fallback | Vite static build, SPA rewrite in `vercel.json` |
| API (`worker/index.ts` fetch, `/api/*`, `/admin`) | Worker, `run_worker_first` | Vercel Functions (Node runtime) under `api/`, one catch-all `api/[...path].ts` that calls the existing router |
| D1 `DB` (56 call sites, 10 SQL migrations) | SQLite on D1 | Postgres (Neon via Vercel Marketplace). Migrations ported from SQLite dialect; data exported with `wrangler d1 export` and imported |
| KV `BOOK` (13 call sites) | Workers KV | Upstash Redis via Marketplace (same get/put JSON shape) |
| R2 `ARCHIVE` (2 call sites) | R2 bucket | Vercel Blob (private store) |
| Cron (4 steps 12:00–12:30 UTC daily, `worker/schedule.ts`) | Cron Triggers | Vercel Cron Jobs in `vercel.json` hitting `/api/cron/<step>`, guarded by `CRON_SECRET` (Vercel sends it as a Bearer header automatically) |
| `vars` in `wrangler.jsonc` | Worker vars | Vercel env vars, same names, Production + Preview |
| Secrets `CRON_SECRET`, `SEATDATA_API_KEY`, `APIFY_TOKEN`, admin secret | Worker secrets | Vercel env vars by name (values copied by Billy or from the box secret files, never committed) |
| Custom domain `wizards.billycommandcenter.com` | Worker custom domain | Vercel project domain, CNAME in the billycommandcenter.com zone |

## Steps

1. **Storage adapters first.** Put D1, KV and R2 behind small interfaces (`db`, `book`, `archive`) so the same business code runs on both hosts. Cloudflare keeps working through this step, so it can merge on its own.
2. **Postgres schema.** Translate the 10 migrations (SQLite → Postgres types, `INTEGER PRIMARY KEY` → identity, date text stays text). Run vitest against a Neon branch.
3. **Vercel entry points.** `api/[...path].ts` wraps the existing fetch router (Request/Response is already web-standard). `api/cron/[step].ts` calls `runStep`. Add `vercel.json` with the SPA rewrite and four crons.
4. **Data copy.** Export D1, import to Postgres; copy the KV book keys and the R2 archive objects. Run on a preview with `DRY_RUN=true` and `INGEST_ENABLED=false` so SeatData is not billed twice.
5. **Parity check.** Compare `/api/book` and the grid between Cloudflare and the preview (bundle hash, `tm_event_id`, TM links), on desktop and a 390px phone.
6. **Cutover (needs Billy's go).** Freeze crons on Cloudflare, final data sync, flip `INGEST_ENABLED` on Vercel, point the domain. Cloudflare Worker, D1, KV and R2 stay in place as rollback.

## Risks

- SeatData spend caps (50 pulls, $2/ET day) must hold across both hosts during the overlap. Only one host may have ingest on at a time.
- D1 SQL that relies on SQLite behavior (`INSERT OR REPLACE`, loose typing) needs rewriting.
- Vercel Cron on a Hobby team allows daily schedules only; the four daily steps fit.
- The team already has older Vercel projects `wizards-107p` and `wizards-107p-book`. Reuse or archive one rather than adding a third.

## Not in this PR

No code moves yet. This PR only adds the plan so it can be reviewed in Linear.
