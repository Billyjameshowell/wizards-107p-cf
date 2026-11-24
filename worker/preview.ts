/**
 * Preview-only Worker. Do not rename this to wizards-107p-cf.
 * It serves the new UI, injects noindex, and proxies read-only book APIs
 * to production. It has no D1, KV, R2, cron, or custom domain.
 */
const PROD = "https://wizards-107p-cf.dfm7gb44c6.workers.dev";
const READ = new Set(["/api/book", "/api/trends", "/api/grid", "/api/freshness", "/api/export"]);

function isReadApi(pathname: string, method: string): boolean {
  return method === "GET" && READ.has(pathname);
}

export default {
  async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) {
      if (!isReadApi(url.pathname, request.method)) {
        return new Response("This preview does not run admin or write routes.", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
        });
      }
      const dest = new URL(url.pathname + url.search, PROD);
      const res = await fetch(dest, { headers: { accept: request.headers.get("accept") || "application/json" } });
      const headers = new Headers(res.headers);
      headers.set("x-robots-tag", "noindex, nofollow");
      return new Response(res.body, { status: res.status, headers });
    }

    const res = await env.ASSETS.fetch(request);
    const type = res.headers.get("content-type") || "";
    const headers = new Headers(res.headers);
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    if (!type.includes("text/html")) return new Response(res.body, { status: res.status, headers });
    const html = (await res.text()).replace("</head>", '<meta name="robots" content="noindex, nofollow" /></head>');
    return new Response(html, { status: res.status, headers });
  },
};
