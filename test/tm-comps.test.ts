import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  finalizeAttempt,
  insertComps,
  runTmCron,
  startPull,
  sweepPending,
  tmCompsCsvResponse,
  tmWebhookResponse,
  TM_EVENTS,
  type FetchLike,
} from "../worker/tm-comps";
import { annotate, etParts, eventsForPull, isTarget, parseTmItems, pullKindAt, TM_COMPS_COLUMNS } from "../worker/tm-spec";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tm-quickpicks-synthetic.json", import.meta.url), "utf8")).items as unknown[];
const expected = JSON.parse(readFileSync(new URL("./fixtures/tm-quickpicks-expected.json", import.meta.url), "utf8")) as { raw: number; target: unknown[][] };
const challenge = [{ eventId: "TEST", challenge: true, quickpicks: [], captured: [], errors: [] }];
const small = JSON.parse(JSON.stringify(fixture));
small[0].quickpicks[0].json.picks = small[0].quickpicks[0].json.picks.slice(0, 10);

function d1(db: DatabaseSync) {
  const statement = (sql: string, params: unknown[]) => ({
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { results: [], meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])), meta: {} }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
  });
  return {
    prepare: (sql: string) => ({ ...statement(sql, []), bind: (...params: unknown[]) => statement(sql, params) }),
  };
}

type Call = { method: string; url: string; body?: unknown };

/** Fake Apify: a queue of datasets handed out run by run, and an optional hard limit. */
function fakeApify(opts: { datasets: unknown[][]; atLimit?: boolean; startLimitAfter?: number }) {
  const calls: Call[] = [];
  const runs = new Map<string, number>();
  let n = 0;
  const f: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === "/v2/users/me/limits") {
      return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: opts.atLimit ? 5 : 1.2 } } });
    }
    if (method === "POST" && url.pathname.startsWith("/v2/acts/apify~playwright-scraper/runs")) {
      if (opts.startLimitAfter != null && n >= opts.startLimitAfter) {
        return new Response(JSON.stringify({ error: { type: "platform-feature-disabled", message: "Monthly usage hard limit exceeded" } }), { status: 403 });
      }
      const id = `run${n}`;
      runs.set(id, n++);
      return Response.json({ data: { id, defaultDatasetId: `ds-${id}`, status: "READY" } });
    }
    const run = /^\/v2\/actor-runs\/(.+)$/.exec(url.pathname);
    if (run) return Response.json({ data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds-${run[1]}`, usageTotalUsd: 0.031, stats: { runTimeSecs: 41 } } });
    const ds = /^\/v2\/datasets\/ds-(.+)\/items$/.exec(url.pathname);
    if (ds) return Response.json(opts.datasets[runs.get(ds[1]) ?? 0] ?? []);
    return new Response("not found", { status: 404 });
  };
  return { f, calls, starts: () => calls.filter((c) => c.method === "POST").length };
}

let db: DatabaseSync;
let env: Env;
const atlanta = TM_EVENTS.find((e) => e.event_date === "2026-11-04")!;
const detroit = TM_EVENTS.find((e) => e.event_date === "2026-11-12")!;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0011_tm_comps.sql", import.meta.url), "utf8"));
  env = { DB: d1(db), APIFY_TOKEN: "test-token", CRON_SECRET: "test-secret", TM_COMPS_ENABLED: "true" } as unknown as Env;
});

const runsTable = () => db.prepare("SELECT * FROM tm_runs ORDER BY id").all() as Record<string, unknown>[];
const compsCount = () => Number((db.prepare("SELECT COUNT(*) AS n FROM tm_comps").get() as { n: number }).n);

describe("tm-spec parsing matches the box scraper", () => {
  it("parses the synthetic quickpicks fixture exactly as scrape_tm.py does", () => {
    const { listings } = parseTmItems(fixture);
    expect(listings.length).toBe(expected.raw);
    const target = listings.map(annotate).filter(isTarget)
      .map((r) => [r.listing_id, r.section, r.row, r.seats, r.qty_available, r.price_per_ticket_all_in, r.side_of_arena, r.near_107])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const want = [...expected.target].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(target).toEqual(want);
  });
});

describe("schedule (ET, both DST offsets)", () => {
  it.each([
    ["2026-10-30T14:00:00Z", "full"], // 10:00 EDT
    ["2026-10-30T21:00:00Z", "full"], // 17:00 EDT
    ["2026-10-30T22:00:00Z", "gameday"], // 18:00 EDT
    ["2026-10-30T15:00:00Z", null], // 11:00 EDT
    ["2026-10-30T23:00:00Z", null], // 19:00 EDT
    ["2026-11-02T15:00:00Z", "full"], // 10:00 EST
    ["2026-11-02T14:00:00Z", null], // 09:00 EST
    ["2026-11-02T22:00:00Z", "full"], // 17:00 EST
    ["2026-11-02T23:00:00Z", "gameday"], // 18:00 EST
    ["2026-11-02T23:30:00Z", "sweep"],
  ])("%s -> %s", (iso, kind) => {
    expect(pullKindAt(new Date(iso))).toBe(kind);
  });

  it("full = next 45 days unstarted; gameday = today's game only, not after tip-15", () => {
    const now = new Date("2026-10-30T14:00:00Z");
    const full = eventsForPull(TM_EVENTS, "full", now);
    expect(full[0].event_date).toBe("2026-10-30");
    expect(full.every((e) => e.event_date <= "2026-12-14")).toBe(true);
    expect(eventsForPull(TM_EVENTS, "gameday", new Date("2026-10-30T22:00:00Z")).map((e) => e.event_date)).toEqual(["2026-10-30"]);
    const hornets = TM_EVENTS.find((e) => e.event_date === "2026-10-30")!;
    const tip = new Date(hornets.start_utc!);
    expect(eventsForPull(TM_EVENTS, "gameday", new Date(tip.getTime() - 10 * 60_000))).toEqual([]);
  });

  it("captured_at_et carries the ET offset", () => {
    expect(etParts(new Date("2026-10-30T22:00:05Z")).iso).toBe("2026-10-30T18:00:05-04:00");
    expect(etParts(new Date("2026-11-02T23:00:05Z")).iso).toBe("2026-11-02T18:00:05-05:00");
  });
});

describe("account hard limit: quiet skip", () => {
  it("cron logs account_limit, starts nothing, retries nothing", async () => {
    const apify = fakeApify({ datasets: [], atLimit: true });
    const r = await runTmCron(env, new Date("2026-10-30T14:00:00Z"), apify.f);
    expect(r.status).toBe("account_limit");
    expect(apify.starts()).toBe(0);
    const rows = runsTable();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("account_limit");
    expect(rows[0].cost_usd).toBeNull();
  });

  it("a start refused for the hard limit stops the rest of the pull", async () => {
    const apify = fakeApify({ datasets: [fixture], startLimitAfter: 1 });
    const r = await startPull(env, "full", new Date("2026-10-30T14:00:00Z"), apify.f);
    expect(r.started).toHaveLength(1);
    expect(apify.starts()).toBe(2);
    expect(runsTable().map((x) => x.status)).toEqual(["running", "account_limit"]);
  });

  it("disabled flag does nothing", async () => {
    const apify = fakeApify({ datasets: [] });
    const r = await runTmCron({ ...env, TM_COMPS_ENABLED: "false" } as Env, new Date("2026-10-30T14:00:00Z"), apify.f);
    expect(r.status).toBe("disabled");
    expect(apify.calls).toHaveLength(0);
  });
});

describe("start -> webhook -> validate -> retry -> D1", () => {
  it("challenge, then partial, then ok: 3 attempts on fresh session pools, rows written once", async () => {
    // A previous good run for this event sets the partial bar (140 listings).
    db.prepare(`INSERT INTO tm_runs (pull_id, kind, run_id, attempt, event_id, status, raw_listings, et_date, started_at) VALUES ('old','full','old',1,?, 'ok', 140, '2026-10-29', '2026-10-29T14:00:00Z')`).run(atlanta.event_id);
    const apify = fakeApify({ datasets: [challenge, small, fixture] });
    const now = new Date("2026-10-30T14:00:00Z");
    const r = await startPull(env, "full", now, apify.f, { events: [atlanta] });
    expect(r.status).toBe("started");
    const start = apify.calls.find((c) => c.method === "POST")!;
    const input = start.body as Record<string, unknown>;
    expect(input.proxyConfiguration).toEqual({ useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "US" });
    expect(String(input.pageFunction)).toContain("quickpicks");
    expect(new URL(start.url).searchParams.get("maxTotalChargeUsd")).toBe("0.4");
    const hooks = JSON.parse(atob(new URL(start.url).searchParams.get("webhooks")!));
    const hookUrl = new URL(hooks[0].requestUrl);
    expect(hookUrl.pathname).toBe("/api/tm-comps/webhook");

    // Webhook for attempt 1 (challenge page) -> validated from Apify's run + dataset, retry started.
    const res = await tmWebhookResponse(new Request(hookUrl, { method: "POST" }), env, apify.f);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; retry: { attempt: number } };
    expect(body.status).toBe("blocked");
    expect(body.retry.attempt).toBe(2);
    expect(apify.starts()).toBe(2);
    // The same webhook delivered twice is a no-op.
    const again = await tmWebhookResponse(new Request(hookUrl, { method: "POST" }), env, apify.f);
    expect(((await again.json()) as { status: string }).status).toBe("already_final");
    expect(apify.starts()).toBe(2);
  });

  it("finalize chain via fake Apify", async () => {
    db.prepare(`INSERT INTO tm_runs (pull_id, kind, run_id, attempt, event_id, status, raw_listings, et_date, started_at) VALUES ('old','full','old',1,?, 'ok', 140, '2026-10-29', '2026-10-29T14:00:00Z')`).run(atlanta.event_id);
    const apify = fakeApify({ datasets: [challenge, small, fixture] });
    const now = new Date("2026-10-30T14:00:00Z");
    await startPull(env, "full", now, apify.f, { events: [atlanta] });
    const pending = () => db.prepare(`SELECT * FROM tm_runs WHERE status = 'running'`).get() as never;
    const a1 = await finalizeAttempt(env, pending(), apify.f, now);
    expect(a1.status).toBe("blocked");
    const a2 = await finalizeAttempt(env, pending(), apify.f, now);
    expect(a2.status).toBe("partial");
    const a3 = await finalizeAttempt(env, pending(), apify.f, now);
    expect(a3.status).toBe("ok");
    expect(a3.written).toBe(expected.target.length);
    const sessions = runsTable().filter((x) => x.pull_id !== "old").map((x) => x.session_pool);
    expect(new Set(sessions).size).toBe(3);
    expect(runsTable().filter((x) => x.pull_id !== "old").map((x) => [x.attempt, x.status, x.cost_usd])).toEqual([
      [1, "blocked", 0.031], [2, "partial", 0.031], [3, "ok", 0.031],
    ]);
    expect(compsCount()).toBe(expected.target.length);
    const row = db.prepare(`SELECT * FROM tm_comps ORDER BY price_per_ticket_all_in LIMIT 1`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ event_id: atlanta.event_id, event_date: "2026-11-04", opponent: "Atlanta Hawks", attempt: 3, run_status: "ok", captured_at_et: "2026-10-30T10:00:00-04:00" });
  });

  it("three bad attempts keep the best one (most listings)", async () => {
    db.prepare(`INSERT INTO tm_runs (pull_id, kind, run_id, attempt, event_id, status, raw_listings, et_date, started_at) VALUES ('old','full','old',1,?, 'ok', 140, '2026-10-29', '2026-10-29T14:00:00Z')`).run(atlanta.event_id);
    const apify = fakeApify({ datasets: [small, challenge, challenge] });
    const now = new Date("2026-10-30T14:00:00Z");
    await startPull(env, "full", now, apify.f, { events: [atlanta] });
    const pending = () => db.prepare(`SELECT * FROM tm_runs WHERE status = 'running'`).get() as never;
    await finalizeAttempt(env, pending(), apify.f, now);
    await finalizeAttempt(env, pending(), apify.f, now);
    const last = await finalizeAttempt(env, pending(), apify.f, now);
    expect(last.kept_attempt).toBe(1);
    expect(apify.starts()).toBe(3);
    const statuses = db.prepare(`SELECT DISTINCT run_status FROM tm_comps`).all() as { run_status: string }[];
    expect(statuses.map((s) => s.run_status)).toEqual(["partial"]);
  });

  it("sweep finishes a run whose webhook never came, and a second finalize is a no-op", async () => {
    const apify = fakeApify({ datasets: [fixture] });
    await startPull(env, "gameday", new Date("2026-10-30T22:00:00Z"), apify.f, { events: [detroit] });
    const later = new Date(Date.now() + 60 * 60_000); // past the 12-minute stale bar
    const out = (await sweepPending(env, apify.f, later)) as { status: string }[];
    expect(out[0].status).toBe("ok");
    expect(await sweepPending(env, apify.f, later)).toEqual([]);
  });
});

describe("caps", () => {
  it("per-pull cap stops starting attempts once reservations reach $1", async () => {
    const apify = fakeApify({ datasets: [] });
    const r = await startPull({ ...env, TM_ATTEMPT_RESERVE_USD: "0.4" } as Env, "full", new Date("2026-10-30T14:00:00Z"), apify.f);
    expect(r.started).toHaveLength(2);
    expect(r.skipped?.[0].reason).toMatch(/^budget_stop/);
    expect(apify.starts()).toBe(2);
  });
});

describe("dedupe and CSV", () => {
  it("same listing + captured_at inserts once (both paths can feed one table)", async () => {
    const rows = parseTmItems(fixture).listings.map(annotate).filter(isTarget).map((r) => ({
      ...r, captured_at_et: "2026-10-30T10:00:00-04:00", run_id: "x", attempt: 1, run_status: "ok",
      event_id: "E1", event_date: "2026-11-04", opponent: "Atlanta Hawks", source: "ticketmaster_quickpicks_via_apify",
    }));
    expect(await insertComps(env, rows)).toBe(rows.length);
    expect(await insertComps(env, rows)).toBe(0);
    expect(compsCount()).toBe(rows.length);

    const res = await tmCompsCsvResponse(new Request("https://x/api/admin/tm-comps.csv?event=2026-11-04&since=2026-10-01"), env);
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(TM_COMPS_COLUMNS.join(","));
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1]).toMatch(/,True,/);
    const none = await tmCompsCsvResponse(new Request("https://x/api/admin/tm-comps.csv?since=2026-10-31"), env);
    expect((await none.text()).trim().split("\r\n")).toHaveLength(1);
  });

  it("webhook rejects a bad signature", async () => {
    const res = await tmWebhookResponse(new Request(`https://x/api/tm-comps/webhook?n=${"a".repeat(32)}&s=bad`, { method: "POST" }), env);
    expect(res.status).toBe(401);
  });
});
