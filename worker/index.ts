import { authorizeBearer } from "../src/shared/guardrails";
import { ensureArchiveBackfill } from "./archive-store";
import { exportArchive } from "./export";
import { runIngest } from "./ingest";
import { loadLiveBook } from "./store";

const PRIVATE = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env, ctx) {
    ctx.waitUntil(
      ensureArchiveBackfill(env).catch((error) => {
        console.error("price archive backfill", error);
      }),
    );
    const url = new URL(request.url);

    if (url.pathname === "/api/book" && request.method === "GET") {
      const book = await loadLiveBook(env);
      return Response.json(book);
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
      return Response.json(await runIngest(env, "http"));
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runIngest(env, "cron"));
  },
} satisfies ExportedHandler<Env>;
