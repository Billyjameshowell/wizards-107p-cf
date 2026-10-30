import { priceBook } from "../src/shared/book-pricing";
import { authorizeBearer, etDateFrom } from "../src/shared/guardrails";
import { adminStatusResponse, authorizeAdmin } from "./admin-status";
import { exportArchive } from "./export";
import { loadLiveBook } from "./store";
import { freshnessResponse } from "./freshness";
import { instantOfferApiResponse, instantOfferFormResponse } from "./instant-offers";
import { gridResponse } from "./grid";
import { loadModelAsks, trendsResponse } from "./trends";
import { salesResponse } from "./sales";
import { isStep, runStep, stepForCron } from "./schedule";
import { latestTmReads, tmPortalResponse } from "./tm-portal";
import {
  runTmCron,
  startPull,
  sweepPending,
  TM_CRON,
  TM_EVENTS,
  tmCompsCsvResponse,
  tmCompsStatusResponse,
  tmWebhookResponse,
} from "./tm-comps";

const PRIVATE = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env, _ctx) {
    // Archive backfill runs from the daily ingest step, not on every request: saves D1 reads.
    const url = new URL(request.url);

    if (url.pathname === "/admin") {
      return adminStatusResponse(request, env);
    }

    if (url.pathname === "/admin/instant-offer" && request.method === "POST") {
      return instantOfferFormResponse(request, env);
    }

    if (url.pathname === "/api/freshness") {
      return freshnessResponse(env, request);
    }

    if (url.pathname === "/api/book" && request.method === "GET") {
      // Re-price on every read so keep amounts and days-out match today.
      const [live, tm, modelAsks] = await Promise.all([loadLiveBook(env), latestTmReads(env), loadModelAsks(env)]);
      const priced = priceBook(live, etDateFrom(new Date()), modelAsks);
      const book = { ...priced, games: priced.games.map((g) => ({ ...g, tm_portal: tm[g.date] ?? null })) };
      return Response.json(book, { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/api/trends" && request.method === "GET") {
      return trendsResponse(env);
    }

    if (url.pathname === "/api/grid") {
      return gridResponse(env, request);
    }

    if (url.pathname === "/api/export" && request.method === "GET") {
      if (!authorizeBearer(request.headers.get("Authorization"), env.CRON_SECRET)) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: PRIVATE });
      }
      return exportArchive(request, env);
    }

    if (
      url.pathname === "/api/cron" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      if (!authorizeBearer(request.headers.get("Authorization"), env.CRON_SECRET)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      // One step per request (default ingest), the same split the cron uses.
      const step = url.searchParams.get("step") ?? "ingest";
      if (!isStep(step)) return Response.json({ error: "step must be ingest, refit, grid or trends" }, { status: 400 });
      return Response.json((await runStep(step, env, "http")) ?? { ok: true });
    }

    if (url.pathname === "/api/instant-offers" && (request.method === "GET" || request.method === "POST")) {
      return instantOfferApiResponse(request, env);
    }

    if (url.pathname === "/api/sales" && (request.method === "GET" || request.method === "POST")) {
      return salesResponse(request, env);
    }

    if (url.pathname === "/api/tm-portal" && (request.method === "GET" || request.method === "POST")) {
      return tmPortalResponse(request, env);
    }

    if (url.pathname === "/api/tm-comps/webhook" && request.method === "POST") {
      return tmWebhookResponse(request, env);
    }

    if (url.pathname.startsWith("/api/admin/tm-comps")) {
      if (!authorizeAdmin(request.headers.get("Authorization"), env.CRON_SECRET)) {
        return new Response("unauthorized", {
          status: 401,
          headers: { ...PRIVATE, "WWW-Authenticate": 'Basic realm="admin"' },
        });
      }
      if (url.pathname === "/api/admin/tm-comps.csv" && request.method === "GET") {
        return tmCompsCsvResponse(request, env);
      }
      if (url.pathname === "/api/admin/tm-comps" && request.method === "GET") {
        return tmCompsStatusResponse(env);
      }
      if (url.pathname === "/api/admin/tm-comps/run" && request.method === "POST") {
        // Manual pull: ?kind=full|gameday, or ?event=YYYY-MM-DD|<TM id> for one game.
        const kind = url.searchParams.get("kind") === "gameday" ? "gameday" : "full";
        const event = url.searchParams.get("event");
        const events = event ? TM_EVENTS.filter((e) => e.event_date === event || e.event_id === event) : undefined;
        if (event && !events?.length) return Response.json({ error: "unknown event" }, { status: 404, headers: PRIVATE });
        return Response.json(await startPull(env, kind, new Date(), fetch, { events, force: true }), { headers: PRIVATE });
      }
      if (url.pathname === "/api/admin/tm-comps/sweep" && request.method === "POST") {
        return Response.json(await sweepPending(env, fetch, new Date(Date.now() + 60 * 60_000)), { headers: PRIVATE });
      }
      return new Response(null, { status: 404, headers: PRIVATE });
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    if (controller.cron === TM_CRON) {
      // Ticketmaster comps (worker/tm-comps.ts): ET clock picks full / game-day / sweep.
      ctx.waitUntil(
        runTmCron(env, new Date(controller.scheduledTime))
          .then((r) => console.log(JSON.stringify({ tm_comps_cron: r.status, kind: r.kind, pull_id: r.pull_id })))
          .catch((error) => console.error("tm comps", error)),
      );
      return;
    }
    const step = stepForCron(controller.cron);
    if (!step) {
      console.error("no step for cron", controller.cron);
      return;
    }
    ctx.waitUntil(runStep(step, env, "cron", new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
