import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminResponse: vi.fn(),
  adminLoginResponse: vi.fn(),
  assetFetch: vi.fn(),
  loadLiveBook: vi.fn(),
  runIngest: vi.fn(),
}));

vi.mock("../worker/admin", () => ({ adminResponse: mocks.adminResponse, adminLoginResponse: mocks.adminLoginResponse }));
vi.mock("../worker/ingest", () => ({ runIngest: mocks.runIngest }));
vi.mock("../worker/store", () => ({ loadLiveBook: mocks.loadLiveBook }));

import worker from "../worker/index";

const book = {
  asof_et: "2026-09-11 8:20am",
  sell_book_cash: 0,
  vs_6k: -6000,
  season_cost: 6000,
  section: "107",
  row: "P",
  seats: [1, 2],
  list_nothing_until_billy_says: true,
  games: [],
};

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ASSETS: { fetch: mocks.assetFetch },
    CRON_SECRET: "test-secret",
    ...overrides,
  } as unknown as Env;
}

async function fetchWorker(path: string, init?: RequestInit, overrides?: Record<string, unknown>) {
  return worker.fetch(
    new Request(`https://example.test${path}`, init),
    env(overrides),
    {} as ExecutionContext,
  );
}

function expectNoIndex(response: Response) {
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

describe("Worker HTTP handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadLiveBook.mockResolvedValue(book);
    mocks.runIngest.mockResolvedValue({
      trigger: "http",
      ingestEnabled: false,
      dryRun: true,
      skippedReason: "ingest_disabled",
      bookUpdated: false,
      asof_et: book.asof_et,
      sources: [],
    });
    mocks.adminResponse.mockResolvedValue(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    mocks.assetFetch.mockResolvedValue(
      new Response("asset body", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
  });

  it("adds noindex to the book response", async () => {
    const response = await fetchWorker("/api/book");

    expect(response.status).toBe(200);
    expectNoIndex(response);
    expect(await response.json()).toEqual(book);
  });

  it("rejects an unauthenticated cron request without invoking ingest", async () => {
    const response = await fetchWorker("/api/cron");

    expect(response.status).toBe(401);
    expectNoIndex(response);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.runIngest).not.toHaveBeenCalled();
  });

  it("never treats an admin cookie as authorization to start paid ingest", async () => {
    const response = await fetchWorker("/api/cron", {
      method: "POST", headers: { Cookie: "admin_session=remembered-session" },
    });
    expect(response.status).toBe(401);
    expect(mocks.runIngest).not.toHaveBeenCalled();
  });

  it("routes login submissions without invoking ingest", async () => {
    mocks.adminLoginResponse.mockResolvedValue(new Response(null, { status: 303 }));
    const response = await fetchWorker("/admin/login", { method: "POST" });
    expect(response.status).toBe(303);
    expect(mocks.adminLoginResponse).toHaveBeenCalledOnce();
    expect(mocks.runIngest).not.toHaveBeenCalled();
  });

  it("routes unauthenticated admin requests to the admin guard", async () => {
    const response = await fetchWorker("/admin");

    expect(response.status).toBe(401);
    expectNoIndex(response);
    expect(mocks.adminResponse).toHaveBeenCalledOnce();
    expect(mocks.assetFetch).not.toHaveBeenCalled();
  });

  it("serves a disallow-all robots policy with noindex", async () => {
    const response = await fetchWorker("/robots.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
    expectNoIndex(response);
  });

  it.each(["GET", "HEAD"] as const)("forwards %s static requests to ASSETS", async (method) => {
    const response = await fetchWorker("/", { method });

    expect(response.status).toBe(200);
    expectNoIndex(response);
    expect(mocks.assetFetch).toHaveBeenCalledOnce();
    const forwarded = mocks.assetFetch.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe(method);
    expect(forwarded.url).toBe("https://example.test/");
  });

  it("returns a noindex 404 for unknown API routes", async () => {
    const response = await fetchWorker("/api/unknown");

    expect(response.status).toBe(404);
    expectNoIndex(response);
    expect(mocks.assetFetch).not.toHaveBeenCalled();
  });

  it("converts handler exceptions into a noindex 500 response", async () => {
    mocks.loadLiveBook.mockRejectedValueOnce(new Error("D1 unavailable"));

    const response = await fetchWorker("/api/book");

    expect(response.status).toBe(500);
    expectNoIndex(response);
    expect(await response.json()).toEqual({ error: "request_failed" });
  });
});

describe("seed route authorization", () => {
  it("requires bearer auth and POST before seed work", async () => {
    vi.clearAllMocks();
    expect((await fetchWorker("/ingest?seed=1", { method: "POST" })).status).toBe(401);
    expect((await fetchWorker("/ingest?seed=1", { headers: { Authorization: "Bearer test-secret" } })).status).toBe(405);
    expect(mocks.runIngest).not.toHaveBeenCalled();
    await fetchWorker("/ingest?seed=1", { method: "POST", headers: { Authorization: "Bearer test-secret" } });
    expect(mocks.runIngest).toHaveBeenCalledWith(expect.anything(), "http", expect.any(Date), true);
  });
});
