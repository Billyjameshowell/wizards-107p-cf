import { authorizeBearer } from "../src/shared/guardrails";
import { adminResponse, adminLoginResponse } from "./admin";
import { runIngest } from "./ingest";
import { loadLiveBook } from "./store";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (url.pathname === "/admin/login") return adminLoginResponse(request, env);
  if (url.pathname === "/admin" || url.pathname === "/status") {
    return adminResponse(request, env);
  }
  if (url.pathname === "/api/book" && request.method === "GET") {
    return Response.json(await loadLiveBook(env), { headers: { "Cache-Control": "no-store" } });
  }
  if ((url.pathname === "/api/cron" || url.pathname === "/ingest") && ["GET", "POST"].includes(request.method)) {
    if (!authorizeBearer(request.headers.get("Authorization"), env.CRON_SECRET)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const seed = url.searchParams.get("seed") === "1";
    if ((seed || url.pathname === "/ingest") && request.method !== "POST") {
      return Response.json({ error: "post_required" }, { status: 405, headers: { Allow: "POST" } });
    }
    return Response.json(await runIngest(env, "http", new Date(), seed), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname.startsWith("/api/")) return new Response(null, { status: 404 });
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    let response: Response;
    try {
      response = await route(request, env);
    } catch {
      response = Response.json({ error: "request_failed" }, { status: 500 });
    }
    const wrapped = new Response(response.body, response);
    wrapped.headers.set("X-Robots-Tag", "noindex, nofollow");
    wrapped.headers.set("Referrer-Policy", "no-referrer");
    return wrapped;
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runIngest(env, "cron"));
  },
} satisfies ExportedHandler<Env>;
