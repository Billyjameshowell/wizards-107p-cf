import { Hono } from "hono";
import { authorizeBearer } from "@shared/guardrails";
import { runIngest } from "./ingest";
import { loadLiveBook } from "./store";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/book", async (c) => {
  const book = await loadLiveBook(c.env);
  return c.json(book);
});

app.on(["GET", "POST"], "/api/cron", async (c) => {
  if (!authorizeBearer(c.req.header("Authorization"), c.env.CRON_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const summary = await runIngest(c.env, "http");
  return c.json(summary);
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIngest(env, "cron"));
  },
};
