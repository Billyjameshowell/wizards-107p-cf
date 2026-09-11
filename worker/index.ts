import { authorizeBearer } from "../src/shared/guardrails";
import { runIngest } from "./ingest";
import { loadLiveBook } from "./store";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/book" && request.method === "GET") {
      const book = await loadLiveBook(env);
      return Response.json(book);
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
